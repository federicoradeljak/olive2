"""Configurable default language for transcriptions and summaries."""

from __future__ import annotations

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
