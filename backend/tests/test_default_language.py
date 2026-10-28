"""Configurable default language for transcriptions and summaries."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from olive.app import create_app
from olive.db import create_db
from olive.services.ingest import IngestService
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


def test_ingest_forwards_language_override_only_when_given(tmp_path) -> None:
    started: list[dict[str, Any]] = []

    class _Transcription:
        async def start_transcription(self, _meeting_id: str, opts: dict[str, Any]) -> dict[str, Any]:
            started.append(opts)
            return {"status": "queued"}

    clear_app_config_cache()
    handle = create_db(":memory:")
    meetings_dir = str(tmp_path / "meetings")
    ingest_service = IngestService(
        db=handle.engine, meetings_dir=meetings_dir, transcription_service=_Transcription()
    )
    client = TestClient(
        create_app(
            {
                "db": handle.engine,
                "configDir": str(tmp_path),
                "meetingsDir": meetings_dir,
                "ingestService": ingest_service,
            }
        )
    )
    for name, extra in (("a.m4a", {"language": "pt"}), ("b.m4a", {})):
        res = client.post(
            "/api/ingest",
            files={"file": (name, name.encode() * 8, "audio/mp4")},
            data={"autoTranscribe": "true", **extra},
        )
        assert res.status_code == 201, res.text
    assert [o.get("language") for o in started] == ["pt", None]
    handle.engine.dispose()
    clear_app_config_cache()


def test_summary_route_and_config_forward_language(tmp_path) -> None:
    class _Summary:
        default_language = ""

        def __init__(self) -> None:
            self.calls: list[dict[str, Any]] = []

        async def start_summary_generation(self, opts: dict[str, Any]) -> dict[str, Any]:
            self.calls.append(opts)
            return {"meetingId": opts["meetingId"], "stage": "running"}

        def set_default_language(self, language: str) -> None:
            self.default_language = language

    double = _Summary()
    clear_app_config_cache()
    handle = create_db(":memory:")
    client = TestClient(
        create_app({"db": handle.engine, "configDir": str(tmp_path), "summaryService": double})
    )

    assert client.post("/api/meetings/m1/summarize", json={"language": "es"}).status_code == 202
    assert client.post("/api/meetings/m1/summarize", json={}).status_code == 202
    assert [c.get("language") for c in double.calls] == ["es", None]

    assert client.post("/api/config", json={"defaultSummaryLanguage": "pt"}).status_code == 200
    assert double.default_language == "pt"
    handle.engine.dispose()
    clear_app_config_cache()
