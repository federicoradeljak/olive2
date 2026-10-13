"""Main server entrypoint for Olive (port of packages/server/src/index.ts)."""

from __future__ import annotations

import copy
import os
from pathlib import Path
from typing import Any

import uvicorn
from uvicorn.config import LOGGING_CONFIG

from .app import create_app
from .logging_db import logger
from .settings import load_app_config, load_runtime_config


def get_uvicorn_log_config() -> dict[str, Any]:
    cfg = copy.deepcopy(LOGGING_CONFIG)
    cfg["formatters"]["default"]["fmt"] = "%(asctime)s %(levelprefix)s %(message)s"
    cfg["formatters"]["default"]["datefmt"] = "%Y-%m-%dT%H:%M:%S%z"
    cfg["formatters"]["access"]["fmt"] = (
        '%(asctime)s %(levelprefix)s %(client_addr)s - "%(request_line)s" %(status_code)s'
    )
    cfg["formatters"]["access"]["datefmt"] = "%Y-%m-%dT%H:%M:%S%z"
    return cfg


def build_default_app(*, start_plaud_poller: bool = False):
    runtime_config = load_runtime_config()
    app_config = load_app_config(runtime_config.paths)

    hf_models_dir = Path(runtime_config.paths.models_dir) / "huggingface"
    hf_models_dir.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("HF_HOME", str(hf_models_dir))
    os.environ.setdefault("TRANSFORMERS_CACHE", str(hf_models_dir))

    default_web_root = Path(__file__).resolve().parents[3] / "frontend" / "dist"
    web_root = os.environ.get("OLIVE_WEB_ROOT") or str(default_web_root)

    return create_app(
        {
            "webRoot": web_root,
            "meetingsDir": runtime_config.paths.meetings_dir,
            "pollIntervalMinutes": app_config.pollIntervalMinutes,
            "defaultTranscriptionProvider": app_config.transcriptionProvider,
            "bindHost": runtime_config.bind_host,
            "startPlaudPoller": start_plaud_poller,
        }
    )


def run_server() -> None:
    runtime_config = load_runtime_config()
    app_config = load_app_config(runtime_config.paths)
    app = build_default_app(start_plaud_poller=True)

    logger.info(
        "Olive server listening",
        {
            "host": runtime_config.bind_host,
            "port": runtime_config.bind_port,
            "pollIntervalMinutes": app_config.pollIntervalMinutes,
        },
    )
    uvicorn.run(
        app,
        host=runtime_config.bind_host,
        port=runtime_config.bind_port,
        log_config=get_uvicorn_log_config(),
    )


app = build_default_app(start_plaud_poller=False)

if __name__ == "__main__":
    run_server()
