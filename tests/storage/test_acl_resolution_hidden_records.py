# Copyright (c) 2026 Beijing Volcano Engine Technology Co., Ltd.
# SPDX-License-Identifier: Apache-2.0
"""ACL resolution must see the records that a caller's own grants hide.

The tenant filter applied to ``scroll`` hides a restricted record from a user who lacks a
grant. If the resolver reads ACL records through that same filter, the restricted record
disappears, the node falls back to its inherited ``user:*`` access, and the denied user is
allowed in. These tests pin the safe behaviour with a real vector collection.
"""

from types import SimpleNamespace

import pytest

from openviking.server.identity import RequestContext, Role
from openviking.storage.acl import AclAction, AclManager, AclMode, acl_allows
from openviking.storage.collection_schemas import CollectionSchemas
from openviking_cli.session.user_id import UserIdentifier
from openviking_cli.utils.config.vectordb_config import VectorDBBackendConfig

URI = "viking://resources/man354/history/memories/a.v1.d1.md"


class _AclEnabled:
    async def get_account(self, account_id, field):
        del account_id, field
        return SimpleNamespace(enabled=True)


def _ctx(user_id: str, role: Role = Role.USER) -> RequestContext:
    return RequestContext(user=UserIdentifier("acct", user_id), role=role)


@pytest.mark.asyncio
async def test_a_user_without_a_grant_is_denied_a_restricted_record(vector_backend_factory, tmp_path):
    backend = vector_backend_factory(
        config=VectorDBBackendConfig(
            backend="local", name="context", dimension=4, path=str(tmp_path / "vectors")
        )
    )
    try:
        assert await backend.create_collection(
            "context", CollectionSchemas.context_collection("context", 4)
        )
        backend.acl_manager = AclManager(backend, _AclEnabled())
        await backend._upsert_many_raw(
            [
                {
                    "id": "history-record",
                    "uri": URI,
                    "account_id": "acct",
                    "context_type": "resource",
                    "level": 2,
                    "updated_at": "2026-01-01T00:00:00Z",
                    "vector": [1.0, 0.0, 0.0, 0.0],
                    "acl_mode": "restricted",
                    "acl_direct_grants": ["1:user:history"],
                    "acl_inherited_grants": ["7:user:*"],
                }
            ],
            ctx=_ctx("publisher", Role.ADMIN),
        )

        reader = _ctx("history")
        stranger = _ctx("candidate")

        granted = await backend.acl_manager.resolve(URI, reader)
        denied = await backend.acl_manager.resolve(URI, stranger)

        assert granted.mode is AclMode.RESTRICTED
        assert acl_allows(granted, reader, AclAction.READ)
        assert denied.mode is AclMode.RESTRICTED
        assert not acl_allows(denied, stranger, AclAction.READ)
    finally:
        await backend.close()
