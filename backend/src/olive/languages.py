"""ISO 639-1 language codes Olive offers as transcription/summary defaults."""

from __future__ import annotations

# Ask the engine to detect the language (transcription) or follow the
# transcript's language (summaries).
AUTO_LANGUAGE = "auto"

LANGUAGE_NAME_BY_CODE: dict[str, str] = {
    "ar": "Arabic",
    "zh": "Chinese",
    "nl": "Dutch",
    "en": "English",
    "fr": "French",
    "de": "German",
    "it": "Italian",
    "ja": "Japanese",
    "ko": "Korean",
    "pl": "Polish",
    "pt": "Portuguese",
    "ru": "Russian",
    "es": "Spanish",
    "tr": "Turkish",
    "vi": "Vietnamese",
}


def is_auto_language(value: object) -> bool:
    return isinstance(value, str) and value.strip().lower() == AUTO_LANGUAGE


def language_name(code: str) -> str:
    """Human-readable name for prompts (``es``/``es-AR`` -> ``Spanish``).

    Unknown values pass through unchanged so free-form names still work.
    """
    raw = code.strip()
    base = raw.lower().replace("_", "-").split("-")[0]
    return LANGUAGE_NAME_BY_CODE.get(base, raw)
