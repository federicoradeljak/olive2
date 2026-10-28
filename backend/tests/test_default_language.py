"""Configurable default language for transcriptions and summaries."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from olive.app import create_app
from olive.db import create_db
from olive.services.transcription import TranscriptionService
from olive.settings import AppConfig, clear_app_config_cache, load_app_config, resolve_paths, save_app_config


def test_default_languages_empty_and_normalized(tmp_path) -> None:
    assert AppConfig().defaultTranscriptionLanguage == ""
    assert AppConfig().defaultSummaryLanguage == ""

    cfg = AppConfig.model_validate({"defaultTranscriptionLanguage": " ES ", "defaultSummaryLanguage": None})
    assert cfg.defaultTranscriptionLanguage == "es"
    assert cfg.defaultSummaryLanguage == ""

    clear_app_config_cache()
    paths = resolve_paths({"OLIVE_CONFIG_DIR": str(tmp_path)})
    save_app_config({"defaultTranscriptionLanguage": "pt", "defaultSummaryLanguage": "es"}, paths)
    clear_app_config_cache()
    loaded = load_app_config(paths)
    assert loaded.defaultTranscriptionLanguage == "pt"
    assert loaded.defaultSummaryLanguage == "es"
    clear_app_config_cache()


def _transcription_service(default_language: str) -> tuple[TranscriptionService, list[dict[str, Any]]]:
    handle = create_db(":memory:")
    svc = TranscriptionService(
        db=handle.engine, default_provider="assemblyai", default_language=default_language
    )
    seen: list[dict[str, Any]] = []

    async def _capture(_meeting_id: str, opts: dict[str, Any]) -> dict[str, Any]:
        seen.append(opts)
        return {"status": "done"}

    svc.transcribe_meeting_assemblyai = _capture  # type: ignore[method-assign]
    return svc, seen


async def test_transcription_uses_default_language_unless_overridden() -> None:
    svc, seen = _transcription_service("es")
    await svc.transcribe_meeting("m1", {})
    await svc.transcribe_meeting("m1", {"language": "pt"})
    svc.set_default_language("")
    await svc.transcribe_meeting("m1", {})
    assert [o.get("language") for o in seen] == ["es", "pt", None]


def test_config_route_pushes_default_language_to_transcription(tmp_path) -> None:
    class _Transcription:
        default_language = ""

        def set_summary_service(self, _svc: Any) -> None:
            pass

        def set_default_provider(self, _provider: str) -> None:
            pass

        def set_default_language(self, language: str) -> None:
            self.default_language = language

    double = _Transcription()
    clear_app_config_cache()
    handle = create_db(":memory:")
    client = TestClient(
        create_app({"db": handle.engine, "configDir": str(tmp_path), "transcriptionService": double})
    )
    res = client.post("/api/config", json={"defaultTranscriptionLanguage": "ES"})
    assert res.status_code == 200
    assert res.json()["config"]["defaultTranscriptionLanguage"] == "es"
    assert double.default_language == "es"
    handle.engine.dispose()
    clear_app_config_cache()
