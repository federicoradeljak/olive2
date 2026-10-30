"""Custom vocabulary dictionary: setting, injection into transcription jobs."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from cloud_transcription_helpers import FakeTranscriber, seed_cloud_meeting
from olive.app import create_app
from olive.db import create_db
from olive.services.transcription import TranscriptionService
from olive.settings import (
    MAX_VOCABULARY_TERMS,
    AppConfig,
    clear_app_config_cache,
    load_app_config,
    resolve_paths,
    save_app_config,
)


def test_custom_vocabulary_is_normalized_and_persisted(tmp_path) -> None:
    assert AppConfig().customVocabulary == []
    cfg = AppConfig.model_validate(
        {"customVocabulary": [" Olive ", "", "olive", "Plaud  Note", 3, "PLAUD note"]}
    )
    assert cfg.customVocabulary == ["Olive", "Plaud Note"]
    assert AppConfig.model_validate({"customVocabulary": "Olive\n\nPlaud"}).customVocabulary == [
        "Olive",
        "Plaud",
    ]
    assert AppConfig.model_validate({"customVocabulary": None}).customVocabulary == []
    many = [f"term{i}" for i in range(MAX_VOCABULARY_TERMS + 5)]
    assert len(AppConfig.model_validate({"customVocabulary": many}).customVocabulary) == MAX_VOCABULARY_TERMS

    clear_app_config_cache()
    paths = resolve_paths({"OLIVE_CONFIG_DIR": str(tmp_path)})
    save_app_config({"customVocabulary": ["Olive", "Plaud"]}, paths)
    clear_app_config_cache()
    assert load_app_config(paths).customVocabulary == ["Olive", "Plaud"]
    clear_app_config_cache()


async def test_transcription_injects_vocabulary_unless_request_overrides(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    meetings_dir = str(tmp_path / "meetings")
    seed_cloud_meeting(handle.engine, meetings_dir, "m1")
    vocabulary = ["Olive"]
    fake = FakeTranscriber()
    svc = TranscriptionService(
        {"cloudTranscribers": {"assemblyai": fake}, "cloudSpeakerIdentifier": lambda *_args: None},
        db=handle.engine,
        meetings_dir=meetings_dir,
        default_provider="assemblyai",
        custom_vocabulary=lambda: vocabulary,
    )

    await svc.transcribe_meeting("m1", {"force": True})
    await svc.transcribe_meeting("m1", {"force": True, "additionalVocab": ["Plaud"]})
    vocabulary.clear()  # the live getter picks up settings changes
    await svc.transcribe_meeting("m1", {"force": True})
    seen = fake.options
    assert [o.get("additionalVocab") for o in seen] == [["Olive"], ["Plaud"], None]
    handle.engine.dispose()


class _CapturingTranscription:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def transcribe_meeting(self, _meeting_id: str, opts: dict[str, Any]) -> dict[str, Any]:
        self.calls.append(opts)
        return {"status": "done"}


@pytest.mark.parametrize("stream", [False, True])
def test_transcribe_route_forwards_request_vocabulary(tmp_path: Path, stream: bool) -> None:
    handle = create_db(":memory:")
    svc = _CapturingTranscription()
    app = create_app({"db": handle.engine, "configDir": str(tmp_path), "transcriptionService": svc})
    with TestClient(app) as client:
        res = client.post(
            "/api/meetings/m1/transcribe",
            json={"provider": "assemblyai", "stream": stream, "additionalVocab": ["Plaud"]},
        )
    assert res.status_code == 200
    assert [c.get("additionalVocab") for c in svc.calls] == [["Plaud"]]
    handle.engine.dispose()
