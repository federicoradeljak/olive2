"""Named ASR backends selectable for remote (Modal GPU) transcription."""

from __future__ import annotations

from typing import Any, Literal, get_args

AsrModelName = Literal["cohere", "whisper-large-v3-turbo", "whisper-large-v3"]
ASR_MODELS: tuple[str, ...] = get_args(AsrModelName)
DEFAULT_ASR_MODEL: AsrModelName = "cohere"


def normalize_asr_model(value: Any) -> str:
    """Validates an ASR model name; ``None``/blank means the default."""
    raw = str(value or "").strip().lower()
    if not raw:
        return DEFAULT_ASR_MODEL
    if raw not in ASR_MODELS:
        raise ValueError(f"Unknown ASR model {value!r}; expected one of {', '.join(ASR_MODELS)}")
    return raw


def build_asr_engine(name: Any, config: dict[str, Any] | None = None) -> Any:
    """Instantiates the AsrBackend for ``name``."""
    model = normalize_asr_model(name)
    if model == "cohere":
        from .asr_cohere import CohereAsrEngine

        return CohereAsrEngine(config or {})
    from .asr_whisper import FasterWhisperAsrEngine

    return FasterWhisperAsrEngine(model, config)
