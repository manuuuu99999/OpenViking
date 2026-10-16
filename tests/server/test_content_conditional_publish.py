# Copyright (c) 2026 Beijing Volcano Engine Technology Co., Ltd.
# SPDX-License-Identifier: Apache-2.0
"""Conditional publication through ``batch-write`` (MAN-354, option O2).

One batch can copy the previous version into history and then replace or delete the current
file, but only if the current bytes still hash to the version the caller reviewed. The check
and every write happen while all target paths are locked, so a reader of the normal path sees
either the old version or the new one, and a history copy always exists before the current
file changes.
"""

import hashlib
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

import openviking.storage.content_write as content_write_module
from openviking.server.identity import RequestContext, Role
from openviking.storage.acl import AclAction
from openviking.storage.content_write import ContentWriteCoordinator
from openviking_cli.exceptions import (
    ConflictError,
    InvalidArgumentError,
    NotFoundError,
    PermissionDeniedError,
)
from openviking_cli.session.user_id import UserIdentifier

ROOT = "viking://resources/proj"
CURRENT = f"{ROOT}/approved/memories/rule.md"
# "history" sorts after "approved": a plain sort by URI would write the current file first.
HISTORY = f"{ROOT}/history/memories/rule.v1.d1.md"
BASE = "# Base\nversion one"
NEW = "# New\nversion two"


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class _Locks:
    def __init__(self):
        self.held = False
        self.paths = []
        self.releases = 0

    async def pathlock_acquire_exact_batch(self, paths):
        self.paths = list(paths)
        self.held = True
        return {"lease_ref": "lock-1"}

    async def pathlock_to_handoff(self, lease):
        return {"owner_id": "lock-1", "covered_paths": []}

    async def pathlock_handoff(self, lease):
        self.held = False

    async def pathlock_release(self, lease):
        self.held = False
        self.releases += 1


class _VFS:
    """Just enough of VikingFS: directories, files, ordered effects and injectable failures."""

    def __init__(self, files=None):
        self.files = dict(files or {})
        self.effects = []
        self.fail_write_uri = None
        self.fail_rm_uri = None
        self.denied = set()
        self.access_checks = []
        self.orphan_index = set()
        self._async_agfs = _Locks()

    async def _ensure_access(self, uri, ctx, *, action):
        self.access_checks.append((uri, action, bool(getattr(ctx, "bypass_acl", False))))
        if (uri, action) in self.denied:
            raise PermissionDeniedError(f"Access denied for {uri}: {action.value}", resource=uri)

    def _uri_to_path(self, uri, ctx=None):
        return "/virtual/" + uri.removeprefix("viking://")

    async def stat(self, uri, ctx=None, skip_count=False):
        if uri == ROOT or uri.endswith("/memories/preferences"):
            return {"uri": uri, "isDir": True}
        if uri in self.files:
            return {"uri": uri, "isDir": False}
        raise NotFoundError(uri, "file")

    async def read_file(self, uri, ctx=None):
        if uri not in self.files:
            raise NotFoundError(uri, "file")
        return self.files[uri]

    async def read_file_bytes(self, uri, ctx=None):
        return (await self.read_file(uri, ctx=ctx)).encode()

    async def write_file(self, uri, content, ctx=None, lease_ref=None):
        assert lease_ref is not None
        if uri == self.fail_write_uri:
            raise OSError("injected write failure")
        self.files[uri] = content
        self.effects.append(("write", uri))

    async def write_file_bytes(self, uri, content, ctx=None, lease_ref=None):
        await self.write_file(uri, content.decode("utf-8"), ctx=ctx, lease_ref=lease_ref)

    async def rm(self, uri, recursive=False, ctx=None, lease_ref=None, auto_pathlock=True):
        assert lease_ref is not None, "a conditional delete must reuse the batch lock"
        assert recursive is False
        if uri == self.fail_rm_uri:
            raise OSError("injected delete failure")
        self.files.pop(uri, None)
        self.orphan_index.discard(uri)
        self.effects.append(("rm", uri))
        return {"estimated_deleted_count": 1}


@pytest.fixture(autouse=True)
def _no_background_work(monkeypatch):
    queue = SimpleNamespace(enqueue=AsyncMock(return_value="queued"))
    queue_manager = SimpleNamespace(SEMANTIC="semantic", get_queue=lambda *a, **k: queue)
    monkeypatch.setattr(content_write_module, "get_queue_manager", lambda: queue_manager)


def make(files=None, monkeypatch=None):
    vfs = _VFS(files)
    coordinator = ContentWriteCoordinator(vfs)
    return vfs, coordinator


@pytest.fixture
def ctx():
    return RequestContext(user=UserIdentifier.the_default_user(), role=Role.ADMIN)


@pytest.fixture(autouse=True)
def _skip_refresh(monkeypatch):
    async def refresh(self, **kwargs):
        return content_write_module._BatchRefreshOutcome(queue_status=None)

    monkeypatch.setattr(ContentWriteCoordinator, "_refresh_batch", refresh)


def replace_ops(new=NEW, base=BASE):
    return [
        {"uri": HISTORY, "content": f"history of: {base}", "mode": "create"},
        {"uri": CURRENT, "content": new, "mode": "replace", "expected_sha256": sha(base)},
    ]


def retire_ops(base=BASE):
    return [
        {"uri": HISTORY, "content": f"history of: {base}", "mode": "create"},
        {"uri": CURRENT, "mode": "delete", "expected_sha256": sha(base)},
    ]


async def run(coordinator, ctx, operations, **kwargs):
    return await coordinator.batch_write(
        root_uri=ROOT, operations=operations, ctx=ctx, wait=False, **kwargs
    )


@pytest.mark.asyncio
async def test_a_replacement_copies_the_previous_version_before_changing_the_current_one(ctx):
    vfs, coordinator = make({CURRENT: BASE})

    result = await run(coordinator, ctx, replace_ops())

    assert vfs.effects == [("write", HISTORY), ("write", CURRENT)]
    assert vfs.files[CURRENT] == NEW
    assert vfs.files[HISTORY] == f"history of: {BASE}"
    assert result["created"] == [HISTORY]
    assert result["updated"] == [CURRENT]
    assert not vfs._async_agfs.held  # the batch lock is always settled (handed off or released)


@pytest.mark.asyncio
async def test_a_stale_base_writes_nothing_and_keeps_the_current_version(ctx):
    vfs, coordinator = make({CURRENT: "# Somebody else already replaced this"})

    with pytest.raises(ConflictError):
        await run(coordinator, ctx, replace_ops())

    assert vfs.effects == []
    assert HISTORY not in vfs.files
    assert vfs.files[CURRENT] == "# Somebody else already replaced this"
    assert vfs._async_agfs.releases == 1


@pytest.mark.asyncio
async def test_a_retirement_copies_to_history_then_removes_the_current_file(ctx):
    vfs, coordinator = make({CURRENT: BASE})

    result = await run(coordinator, ctx, retire_ops())

    assert vfs.effects == [("write", HISTORY), ("rm", CURRENT)]
    assert CURRENT not in vfs.files
    assert result["deleted"] == [CURRENT]
    assert result["created"] == [HISTORY]


@pytest.mark.asyncio
async def test_a_retirement_from_a_stale_base_deletes_and_writes_nothing(ctx):
    vfs, coordinator = make({CURRENT: NEW})  # the base was already replaced by version two

    with pytest.raises(ConflictError):
        await run(coordinator, ctx, retire_ops())

    assert vfs.effects == []
    assert vfs.files == {CURRENT: NEW}


@pytest.mark.asyncio
async def test_a_retirement_of_a_file_that_is_already_gone_conflicts_and_writes_nothing(ctx):
    vfs, coordinator = make({})

    with pytest.raises(ConflictError):
        await run(coordinator, ctx, retire_ops())

    assert vfs.effects == []


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["replace", "retire"])
async def test_if_the_history_copy_fails_the_current_version_is_untouched(ctx, kind):
    vfs, coordinator = make({CURRENT: BASE})
    vfs.fail_write_uri = HISTORY

    with pytest.raises(OSError, match="injected write"):
        await run(coordinator, ctx, replace_ops() if kind == "replace" else retire_ops())

    assert vfs.files == {CURRENT: BASE}
    assert vfs.effects == []
    assert vfs._async_agfs.releases == 1


@pytest.mark.asyncio
async def test_a_failed_replacement_leaves_history_ahead_of_current_and_the_retry_completes(ctx):
    vfs, coordinator = make({CURRENT: BASE})
    vfs.fail_write_uri = CURRENT

    with pytest.raises(OSError, match="injected write"):
        await run(coordinator, ctx, replace_ops())
    assert vfs.files[CURRENT] == BASE  # still the previous, complete version
    assert vfs.files[HISTORY] == f"history of: {BASE}"  # history ahead of current, never behind

    vfs.fail_write_uri = None
    result = await run(coordinator, ctx, replace_ops())

    assert vfs.files[CURRENT] == NEW
    assert result["updated"] == [HISTORY, CURRENT]  # the retry rewrites the same history bytes


@pytest.mark.asyncio
async def test_a_failed_retirement_keeps_the_memory_readable_and_the_retry_completes(ctx):
    vfs, coordinator = make({CURRENT: BASE})
    vfs.fail_rm_uri = CURRENT

    with pytest.raises(OSError, match="injected delete"):
        await run(coordinator, ctx, retire_ops())
    assert vfs.files[CURRENT] == BASE
    assert HISTORY in vfs.files

    vfs.fail_rm_uri = None
    result = await run(coordinator, ctx, retire_ops())

    assert CURRENT not in vfs.files
    assert result["deleted"] == [CURRENT]


@pytest.mark.asyncio
async def test_completed_delete_is_reported_to_service_even_when_refresh_fails(ctx, monkeypatch):
    vfs, coordinator = make({CURRENT: BASE})
    confirmed = []

    async def fail_refresh(self, **kwargs):
        raise RuntimeError("refresh after removal failed")

    monkeypatch.setattr(ContentWriteCoordinator, "_refresh_batch", fail_refresh)
    with pytest.raises(Exception, match="refresh failed"):
        await run(coordinator, ctx, retire_ops(), deleted_uris=confirmed)

    assert confirmed == [CURRENT]
    assert CURRENT not in vfs.files
    assert HISTORY in vfs.files


@pytest.mark.asyncio
async def test_the_retry_after_a_completed_replacement_is_refused_as_a_stale_base(ctx):
    vfs, coordinator = make({CURRENT: BASE})
    await run(coordinator, ctx, replace_ops())
    before = dict(vfs.files)

    with pytest.raises(ConflictError):
        await run(coordinator, ctx, replace_ops())

    assert vfs.files == before


@pytest.mark.asyncio
async def test_reconcile_retirement_removes_only_orphan_index_for_an_absent_file(ctx):
    vfs, coordinator = make({HISTORY: f"history of: {BASE}"})
    vfs.orphan_index.add(CURRENT)
    confirmed = []
    operation = {"uri": CURRENT, "mode": "reconcile_delete", "expected_sha256": sha(BASE)}

    result = await run(coordinator, ctx, [operation], deleted_uris=confirmed)

    assert result["deleted"] == [CURRENT]
    assert confirmed == [CURRENT]
    assert CURRENT not in vfs.orphan_index
    assert HISTORY in vfs.files
    assert CURRENT not in vfs.files

    vfs.files[CURRENT] = NEW
    with pytest.raises(ConflictError):
        await run(coordinator, ctx, [operation])
    assert vfs.files[CURRENT] == NEW


@pytest.mark.asyncio
async def test_a_delete_needs_the_reviewed_hash_and_carries_no_body(ctx):
    vfs, coordinator = make({CURRENT: BASE})

    with pytest.raises(InvalidArgumentError, match="expected_sha256"):
        await run(coordinator, ctx, [{"uri": CURRENT, "mode": "delete"}])
    with pytest.raises(InvalidArgumentError, match="content"):
        await run(
            coordinator,
            ctx,
            [{"uri": CURRENT, "mode": "delete", "content": "x", "expected_sha256": sha(BASE)}],
        )
    with pytest.raises(InvalidArgumentError, match="acl"):
        await run(
            coordinator,
            ctx,
            [
                {
                    "uri": CURRENT,
                    "mode": "delete",
                    "expected_sha256": sha(BASE),
                    "acl": {"acl_mode": "restricted", "entries": []},
                }
            ],
        )

    assert vfs.files == {CURRENT: BASE}
    assert vfs.effects == []


@pytest.mark.asyncio
async def test_a_delete_is_only_for_resource_files_never_generated_summaries(ctx):
    vfs, coordinator = make({f"{ROOT}/.overview.md": "generated"})

    with pytest.raises(InvalidArgumentError, match="derived"):
        await run(
            coordinator,
            ctx,
            [{"uri": f"{ROOT}/.overview.md", "mode": "delete", "expected_sha256": sha("generated")}],
        )

    memory_root = "viking://user/default/memories/preferences"
    memory_file = f"{memory_root}/a.md"
    with pytest.raises(InvalidArgumentError, match="memor"):
        await coordinator.batch_write(
            root_uri=memory_root,
            operations=[{"uri": memory_file, "mode": "delete", "expected_sha256": sha("x")}],
            ctx=ctx,
            wait=False,
        )
    assert vfs.effects == []


@pytest.mark.asyncio
async def test_a_delete_cannot_be_combined_with_skip_conflicts(ctx):
    vfs, coordinator = make({CURRENT: BASE})

    with pytest.raises(InvalidArgumentError, match="skip_conflicts"):
        await run(coordinator, ctx, retire_ops(), skip_conflicts=True)

    assert vfs.effects == []
    assert vfs.files == {CURRENT: BASE}


@pytest.mark.asyncio
async def test_a_denied_delete_is_refused_before_anything_is_written(ctx):
    vfs, coordinator = make({CURRENT: BASE})
    vfs.denied.add((CURRENT, AclAction.MANAGE))

    with pytest.raises(PermissionDeniedError):
        await run(coordinator, ctx, retire_ops())

    assert vfs.effects == []
    assert vfs.files == {CURRENT: BASE}
    # The same bypass-guard `rm` uses is applied up front, not only when the delete executes.
    assert (CURRENT, AclAction.MANAGE, True) in vfs.access_checks


@pytest.mark.asyncio
async def test_a_denied_history_write_refuses_the_whole_batch(ctx):
    vfs, coordinator = make({CURRENT: BASE})
    vfs.denied.add((HISTORY, AclAction.WRITE))

    with pytest.raises(PermissionDeniedError):
        await run(coordinator, ctx, retire_ops())

    assert vfs.effects == []
    assert vfs.files == {CURRENT: BASE}


@pytest.mark.asyncio
async def test_batches_without_conditions_keep_their_uri_order(ctx):
    vfs, coordinator = make()
    ops = [
        {"uri": f"{ROOT}/b.md", "content": "B", "mode": "upsert"},
        {"uri": f"{ROOT}/a.md", "content": "A", "mode": "upsert"},
    ]

    await run(coordinator, ctx, ops)

    assert vfs.effects == [("write", f"{ROOT}/a.md"), ("write", f"{ROOT}/b.md")]
