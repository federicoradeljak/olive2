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


def test_aligner_fast_path_skips_download_when_staged(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from olive.ml.model_store import _download_aligner, _is_aligner_staged

    staged = tmp_path / "aligner" / "mms-300m-aligner.onnx"
    staged.parent.mkdir(parents=True)
    assert _is_aligner_staged(tmp_path) is False
    staged.write_bytes(b"x" * (2 * 1024 * 1024))
    assert _is_aligner_staged(tmp_path) is True

    # Must return without touching the file or needing the network/import.
    mtime_before = staged.stat().st_mtime_ns
    _download_aligner(tmp_path)
    assert staged.stat().st_mtime_ns == mtime_before


def test_cohere_staged_complete_roundtrip(tmp_path: Path) -> None:
    from olive.ml.asr_cohere import _COHERE_STAGED_MIN_SIZES, is_cohere_staged_complete

    assert is_cohere_staged_complete(tmp_path) is False
    for name, min_size in _COHERE_STAGED_MIN_SIZES:
        (tmp_path / name).write_bytes(b"x" * min_size)
    assert is_cohere_staged_complete(tmp_path) is True
    # Symlinked files must not fast-path (ONNX Runtime 1.25 rejects symlinks).
    (tmp_path / "tokens.txt").unlink()
    (tmp_path / "tokens.txt").symlink_to(tmp_path / "cohere-decoder.int8.onnx")
    assert is_cohere_staged_complete(tmp_path) is False


def test_cohere_stage_skips_hub_calls_when_complete(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    import olive.ml.asr_cohere as cohere_mod
    from olive.ml.asr_cohere import _COHERE_STAGED_MIN_SIZES, stage_cohere_int8_model_dir

    monkeypatch.setenv("OLIVE_MODELS_DIR", str(tmp_path))
    cohere_dir = tmp_path / "cohere-int8"
    cohere_dir.mkdir(parents=True)
    for name, min_size in _COHERE_STAGED_MIN_SIZES:
        (cohere_dir / name).write_bytes(b"x" * min_size)

    def fail_hub(**_kwargs: object) -> str:
        raise AssertionError("hf_hub_download must not be called when staged")

    monkeypatch.setattr(cohere_mod, "hf_hub_download", fail_hub)
    assert stage_cohere_int8_model_dir(None) == cohere_dir


def test_download_runs_all_steps_despite_one_failure(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("OLIVE_MODELS_DIR", str(tmp_path))
    called: list[str] = []

    def ok(name: str) -> None:
        called.append(name)

    def boom() -> None:
        called.append("boom")
        raise ConnectionError("down")

    monkeypatch.setattr(model_store, "_download_aligner", lambda _d: ok("aligner"))
    monkeypatch.setattr(model_store, "_download_pyannote", lambda _t: ok("pyannote"))
    monkeypatch.setattr(model_store, "_download_cohere", lambda _t: boom())

    import huggingface_hub

    monkeypatch.setattr(huggingface_hub, "hf_hub_download", lambda **_k: ok("wespeaker"))

    with pytest.raises(ModelStorageError, match="could not download Cohere"):
        download_local_models(None)
    # Parallel run: every step was attempted even though one failed.
    assert sorted(called) == ["aligner", "boom", "pyannote", "wespeaker"]
