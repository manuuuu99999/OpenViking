"""Synthetic MAN-354 smoke against an installed OpenViking wheel, not source checkout.

Run from outside the checkout. HTTP is in-process; no TCP listener or external model call.
"""

import asyncio
import hashlib
import os
import tempfile
from pathlib import Path

import httpx

from openviking.models.embedder.base import DenseEmbedderBase, EmbedResult
from openviking.server.app import create_app
from openviking.server.auth.plugins import DevAuthPlugin
from openviking.server.auth.registry import get_registry
from openviking.server.config import ServerConfig
from openviking.server.dependencies import set_service
from openviking.service.core import OpenVikingService
from openviking_cli.session.user_id import UserIdentifier
from openviking_cli.utils.config.embedding_config import EmbeddingConfig
from openviking_cli.utils.config.open_viking_config import OpenVikingConfigSingleton
from openviking_cli.utils.config.vlm_config import VLMConfig


class SyntheticEmbedder(DenseEmbedderBase):
    def __init__(self):
        super().__init__(model_name="man354-synthetic")

    def embed(self, text, is_query=False):
        return EmbedResult(dense_vector=[0.1] * 1024)

    def get_dimension(self):
        return 1024


async def synthetic_completion(self, prompt, thinking=False):
    return "# Synthetic summary\n\nOnly invented MAN-354 content."


async def synthetic_vision(self, prompt, images, thinking=False):
    return "Synthetic image description."


async def main():
    import openviking
    package_file = Path(openviking.__file__).resolve()
    script_file = Path(__file__).resolve()
    if os.environ.get("MAN354_LOCAL_SOURCE_PROBE") != "1":
        assert "site-packages" in str(package_file).lower(), package_file
        assert script_file.parent not in package_file.parents, (script_file, package_file)
    print("PACKAGE_FROM_SOURCE_LAB" if os.environ.get("MAN354_LOCAL_SOURCE_PROBE") == "1" else "PACKAGE_FROM_INSTALLED_WHEEL", package_file)

    EmbeddingConfig.get_embedder = lambda self: SyntheticEmbedder()
    VLMConfig.is_available = lambda self: True
    VLMConfig.get_completion_async = synthetic_completion
    VLMConfig.get_vision_completion_async = synthetic_vision

    # On Windows the native queue may retain its DB handle until process exit.
    # CI runners are disposable; cleanup is retried by the calling shell afterward.
    with tempfile.TemporaryDirectory(prefix="man354-wheel-", ignore_cleanup_errors=True) as tmp:
        workspace = Path(tmp) / "data"
        OpenVikingConfigSingleton.reset_instance()
        OpenVikingConfigSingleton.initialize(config_dict={
            "storage": {"workspace": str(workspace), "agfs": {"backend": "local"},
                        "vectordb": {"backend": "local"}},
            "embedding": {"dense": {"provider": "openai", "model": "man354-synthetic",
                                     "api_key": "synthetic-never-sent", "dimension": 1024}},
        })
        service = OpenVikingService(path=str(workspace), user=UserIdentifier.the_default_user("fixture"))
        try:
            await service.initialize()
            service.viking_fs.query_embedder = SyntheticEmbedder()
            app = create_app(config=ServerConfig(), service=service)
            set_service(service)
            registry = get_registry()
            if registry.get("dev") is None:
                registry.register(DevAuthPlugin)
            app.state.auth_plugin = registry.get("dev")()
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver",
                                         timeout=90, trust_env=False) as client:
                root = "viking://resources/man354-synthetic"
                current = root + "/approved/rule.md"
                history = root + "/history/rule.v1.md"
                content = "# Synthetic rule\nFaro synthetic owner Marta"
                create = await client.post("/api/v1/content/write", json={
                    "uri": current, "content": content, "mode": "create", "wait": True})
                assert create.status_code == 200, (create.status_code, create.text[:500])

                async def search():
                    response = await client.post("/api/v1/search/find", json={
                        "query": "Faro synthetic owner Marta", "target_uri": root,
                        "context_type": ["resource"], "limit": 100,
                        "score_threshold": 0.0})
                    assert response.status_code == 200, (response.status_code, response.text[:500])
                    result = response.json()["result"]
                    return {hit["uri"] for group in ("resources", "memories", "skills")
                            for hit in result.get(group, [])}

                before = await search()
                assert current in before, ("positive search control failed", sorted(before))
                read = await client.get("/api/v1/content/read", params={"uri": current})
                assert read.status_code == 200 and read.json()["result"] == content, read.text[:500]
                def digest(text):
                    return hashlib.sha256(text.encode()).hexdigest()

                async def batch(operations):
                    return await client.post("/api/v1/content/batch-write", json={
                        "root_uri": root, "wait": True, "operations": operations})

                async def read_text(uri):
                    response = await client.get("/api/v1/content/read", params={"uri": uri})
                    return response.status_code, (response.json().get("result")
                                                  if response.status_code == 200 else None)

                # Another writer approves a replacement (v1 -> v2) while a second
                # one still holds the v1 revision it read earlier.
                v2 = "# Synthetic rule\nFaro synthetic owner Marta (second approved version)"
                replace = await batch([
                    {"uri": history, "content": content, "mode": "create"},
                    {"uri": current, "content": v2, "mode": "replace",
                     "expected_sha256": digest(content)},
                ])
                assert replace.status_code == 200, (replace.status_code, replace.text[:500])
                assert await read_text(current) == (200, v2)

                # S-stale-retire: a retirement prepared against v1 must not delete v2.
                stale_history = root + "/history/rule.stale-retire.md"
                stale_retire = await batch([
                    {"uri": stale_history, "content": content, "mode": "create"},
                    {"uri": current, "mode": "delete", "expected_sha256": digest(content)},
                ])
                assert stale_retire.status_code == 409, (stale_retire.status_code, stale_retire.text[:500])
                assert await read_text(current) == (200, v2), "stale retirement changed the current version"
                assert (await read_text(stale_history))[0] == 404, "stale retirement wrote a history copy"
                assert current in await search(), "stale retirement removed the current version from search"

                # S-stale-replace: a replacement prepared against v1 must not overwrite v2.
                stale_replace = await batch([
                    {"uri": root + "/history/rule.stale-replace.md", "content": content, "mode": "create"},
                    {"uri": current, "content": "# stale overwrite", "mode": "replace",
                     "expected_sha256": digest(content)},
                ])
                assert stale_replace.status_code == 409, (stale_replace.status_code, stale_replace.text[:500])
                assert await read_text(current) == (200, v2), "stale replacement overwrote the current version"
                assert (await read_text(root + "/history/rule.stale-replace.md"))[0] == 404

                # S-race: two writers read v2 and submit at the same instant.
                # Exactly one may win; the loser must leave no trace.
                variants = {
                    "a": "# Synthetic rule\nFaro synthetic owner Marta (writer A)",
                    "b": "# Synthetic rule\nFaro synthetic owner Marta (writer B)",
                }
                histories = {k: root + f"/history/rule.race-{k}.md" for k in variants}
                racers = await asyncio.gather(*[
                    batch([
                        {"uri": histories[k], "content": v2, "mode": "create"},
                        {"uri": current, "content": variants[k], "mode": "replace",
                         "expected_sha256": digest(v2)},
                    ]) for k in variants
                ])
                statuses = sorted(r.status_code for r in racers)
                assert statuses == [200, 409], ("race outcomes", statuses, [r.text[:300] for r in racers])
                winner = next(k for k, r in zip(variants, racers) if r.status_code == 200)
                loser = next(k for k in variants if k != winner)
                assert await read_text(current) == (200, variants[winner]), "current is not the winner's content"
                assert await read_text(histories[winner]) == (200, v2), "winner's history copy is missing"
                assert (await read_text(histories[loser]))[0] == 404, "loser left a history copy"

                # Fresh retirement with the revision actually current.
                final_text = variants[winner]
                retire = await batch([
                    {"uri": root + "/history/rule.final.md", "content": final_text, "mode": "create"},
                    {"uri": current, "mode": "delete", "expected_sha256": digest(final_text)},
                ])
                assert retire.status_code == 200, (retire.status_code, retire.text[:500])
                assert retire.json()["result"]["deleted"] == [current], retire.text[:500]
                assert current not in await search(), "retired URI still in semantic search"
                assert await read_text(history) == (200, content), "v1 history lost"
                assert await read_text(histories[winner]) == (200, v2), "v2 history lost"
                assert await read_text(root + "/history/rule.final.md") == (200, final_text)
                assert (await read_text(current))[0] == 404
                print("PASS: stale retire/replace rejected without writes, race had one winner, "
                      "visible before, absent after retirement, history intact")
        finally:
            await service.close()
            OpenVikingConfigSingleton.reset_instance()


if __name__ == "__main__":
    asyncio.run(main())
