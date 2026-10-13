from __future__ import annotations

from pathlib import Path

import pytest

from olive.main import prepare_container_models
from olive.ml import model_store
from olive.ml.model_store import ModelStorageError, download_local_models, ensure_models_volume


def test_unmounted_models_dir_is_rejected(tmp_path: Path) -> None:
    # tmp_path lives on the same device as its parent, so it is not a mount point.
    with pytest.raises(ModelStorageError, match="not a mounted volume"):
        ensure_models_volume(tmp_path)


def test_missing_models_dir_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(ModelStorageError, match="does not exist"):
        ensure_models_volume(tmp_path / "missing")


def test_container_preflight_is_noop_outside_docker(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OLIVE_DOCKER", raising=False)
    called: list[str] = []
    monkeypatch.setattr(model_store, "download_local_models", lambda token: called.append("dl"))
    prepare_container_models()
    assert called == []


def test_container_preflight_exits_with_reason_when_not_mounted(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("OLIVE_DOCKER", "1")
    monkeypatch.setenv("OLIVE_MODELS_DIR", str(tmp_path))
    with pytest.raises(SystemExit) as exc:
        prepare_container_models()
    assert "not a mounted volume" in str(exc.value)


def test_download_failure_names_the_model(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("OLIVE_MODELS_DIR", str(tmp_path))

    import huggingface_hub

    def fake_hf_download(**_kwargs: object) -> str:
        return str(tmp_path / "wespeaker.onnx")

    def offline(_models_dir: Path) -> None:
        raise ConnectionError("network unreachable")

    monkeypatch.setattr(huggingface_hub, "hf_hub_download", fake_hf_download)
    monkeypatch.setattr(model_store, "_download_aligner", offline)

    with pytest.raises(ModelStorageError, match="could not download ctc-forced-aligner.*network unreachable"):
        download_local_models(None)
