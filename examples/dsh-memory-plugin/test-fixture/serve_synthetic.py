"""Disposable MAN-350 OpenViking server with deterministic models, never live data.

Install openviking==0.5.0 in a dedicated virtual environment. Set
MAN350_SYNTHETIC_ROOT to a separate directory named ov-man350-test before running.
The real server supplies storage, identities, HTTP routes and authorization.
"""

import argparse
import asyncio
import json
import os
import re
import secrets
import socket
from importlib.metadata import version as package_version
from pathlib import Path

ROOT = Path(os.environ.get("MAN350_SYNTHETIC_ROOT", "")).resolve()
if not os.environ.get("MAN350_SYNTHETIC_ROOT") or ROOT.name != "ov-man350-test" or not ROOT.is_dir():
    raise RuntimeError("MAN350_SYNTHETIC_ROOT must name an existing isolated ov-man350-test directory")

parser = argparse.ArgumentParser()
parser.add_argument("--smoke", action="store_true", help="Verify boot and identities, then stop")
args = parser.parse_args()
run_dir = ROOT / ("run-" + secrets.token_hex(6))
run_dir.mkdir(mode=0o700)
config_path = run_dir / "ov.conf"
root_key = "man350-synthetic-" + secrets.token_urlsafe(32)
config = {
    "storage": {
        "workspace": str(run_dir / "data"),
        "agfs": {"backend": "local"},
        "vectordb": {"backend": "local"},
    },
    "embedding": {"dense": {
        "provider": "openai", "model": "man350-test-embedder",
        "api_key": "synthetic-never-sent", "dimension": 1024,
    }},
    "server": {"host": "127.0.0.1", "auth_mode": "api_key", "root_api_key": root_key},
}
config_path.write_text(json.dumps(config), encoding="utf-8")
os.environ["OPENVIKING_CONFIG_FILE"] = str(config_path)
os.environ["NO_PROXY"] = "127.0.0.1,localhost"
os.environ["no_proxy"] = "127.0.0.1,localhost"

print("fixture: loading installed server", flush=True)
import httpx
import uvicorn
from openviking.models.embedder.base import DenseEmbedderBase, EmbedResult
from openviking.server.app import create_app
from openviking.server.config import ServerConfig
from openviking.server.identity import RequestContext, Role
from openviking.service.core import OpenVikingService
from openviking_cli.session.user_id import UserIdentifier
from openviking_cli.utils.config.embedding_config import EmbeddingConfig
from openviking_cli.utils.config.open_viking_config import OpenVikingConfigSingleton
from openviking_cli.utils.config.vlm_config import VLMConfig


class SyntheticEmbedder(DenseEmbedderBase):
    def __init__(self):
        super().__init__(model_name="man350-test-embedder")

    def embed(self, text, is_query=False):
        return EmbedResult(dense_vector=[0.1] * 1024)

    def get_dimension(self):
        return 1024


EmbeddingConfig.get_embedder = lambda self: SyntheticEmbedder()
VLMConfig.is_available = lambda self: True


async def synthetic_completion(self, prompt=None, thinking=False, **kwargs):
    if "messages" in kwargs:
        # The server still runs its real extraction pipeline; only its external
        # model response is controlled so the test always observes one candidate.
        messages = json.dumps(kwargs["messages"], ensure_ascii=False, default=str)
        match = re.search(r"MAN351_FACT_[a-f0-9]{32}", messages)
        if match is None:
            fact_marker = "MAN350_FACT_fixturealpha"
            event_name = "man350_fixture_delivery"
        else:
            fact_marker = match.group(0)
            event_name = f"man351_fixture_delivery_{fact_marker.removeprefix('MAN351_FACT_')}"
        return (
            "sdk.create_events("
            f"event_name='{event_name}', "
            "goal='record synthetic delivery', "
            f"summary='{fact_marker} happened in the synthetic project.', "
            "ranges='0')"
        )
    return "# Synthetic test summary\n\nInvented content only."


async def synthetic_vision(self, prompt, images, thinking=False):
    return "Synthetic image description."


VLMConfig.get_completion_async = synthetic_completion
VLMConfig.get_vision_completion_async = synthetic_vision
print("fixture: configuring isolated storage", flush=True)
OpenVikingConfigSingleton.initialize(config_dict=config)
service = OpenVikingService(path=str(run_dir / "data"), user=UserIdentifier.the_default_user("fixture"))


async def main():
    print("fixture: initializing native service", flush=True)
    await service.initialize()
    print("fixture: native service initialized", flush=True)
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    app = create_app(
        config=ServerConfig(host="127.0.0.1", port=port, auth_mode="api_key", root_api_key=root_key),
        service=service,
    )
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    task = asyncio.create_task(server.serve())
    try:
        for _ in range(200):
            if task.done():
                await task
                raise RuntimeError("Synthetic server exited before startup")
            if server.started and getattr(app.state, "api_key_manager", None) is not None:
                break
            await asyncio.sleep(0.1)
        else:
            raise RuntimeError("Synthetic server did not start within 20 seconds")
        manager = app.state.api_key_manager
        identities = {"root": root_key}
        for account in ("man350_project_a", "man350_project_b", "man350_legacy"):
            identities[account + ":admin"] = await manager.create_account(account, "fixture_admin")
            admin_context = RequestContext(user=UserIdentifier(account, "fixture_admin"), role=Role.ADMIN)
            await service.initialize_account_directories(admin_context)
            await service.initialize_user_directories(admin_context)
            for user in ("candidate", "approved", "history"):
                identities[account + ":" + user] = await manager.register_user(account, user)
                context = RequestContext(user=UserIdentifier(account, user), role=Role.USER)
                await service.initialize_user_directories(context)
        base_url = f"http://127.0.0.1:{port}"
        async with httpx.AsyncClient(timeout=5, trust_env=False) as client:
            response = await client.get(base_url + "/health")
            response.raise_for_status()
            if response.json().get("status") != "ok":
                raise RuntimeError("Synthetic server did not report healthy")
        server_version = package_version("openviking")
        (run_dir / "identities.json").write_text(
            json.dumps({
                "url": base_url,
                "server_version": server_version,
                "extraction_fixture": "man351-deterministic-event-v1",
                "keys": identities,
            }, indent=2),
            encoding="utf-8",
        )
        print(
            f"Synthetic OpenViking {server_version} ready at {base_url}; "
            f"identities: {run_dir / 'identities.json'}",
            flush=True,
        )
        if args.smoke:
            return
        await task
    finally:
        server.should_exit = True
        await task
        await service.close()


if __name__ == "__main__":
    asyncio.run(main())
