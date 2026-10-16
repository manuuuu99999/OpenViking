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
                retire = await client.post("/api/v1/content/batch-write", json={
                    "root_uri": root, "wait": True,
                    "operations": [
                        {"uri": history, "content": content, "mode": "create"},
                        {"uri": current, "mode": "delete",
                         "expected_sha256": hashlib.sha256(content.encode()).hexdigest()},
                    ]})
                assert retire.status_code == 200, (retire.status_code, retire.text[:500])
                assert retire.json()["result"]["deleted"] == [current], retire.text[:500]
                assert current not in await search(), "retired URI still in semantic search"
                prior = await client.get("/api/v1/content/read", params={"uri": history})
                assert prior.status_code == 200 and prior.json()["result"] == content, prior.text[:500]
                missing = await client.get("/api/v1/content/read", params={"uri": current})
                assert missing.status_code == 404, (missing.status_code, missing.text[:500])
                print("PASS: visible before, absent after retirement, history intact")
        finally:
            await service.close()
            OpenVikingConfigSingleton.reset_instance()


if __name__ == "__main__":
    asyncio.run(main())
