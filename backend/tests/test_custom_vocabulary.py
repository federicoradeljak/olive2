"""Custom vocabulary dictionary: setting, injection into transcription jobs."""

from __future__ import annotations

from typing import Any

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


async def test_transcription_injects_vocabulary_unless_request_overrides() -> None:
    handle = create_db(":memory:")
    vocabulary = ["Olive"]
    svc = TranscriptionService(
        db=handle.engine, default_provider="assemblyai", custom_vocabulary=lambda: vocabulary
    )
    seen: list[dict[str, Any]] = []

    async def _capture(_meeting_id: str, opts: dict[str, Any]) -> dict[str, Any]:
        seen.append(opts)
        return {"status": "done"}

    svc.transcribe_meeting_assemblyai = _capture  # type: ignore[method-assign]
    await svc.transcribe_meeting("m1", {})
    await svc.transcribe_meeting("m1", {"additionalVocab": ["Plaud"]})
    vocabulary.clear()  # the live getter picks up settings changes
    await svc.transcribe_meeting("m1", {})
    assert [o.get("additionalVocab") for o in seen] == [["Olive"], ["Plaud"], None]
    handle.engine.dispose()
