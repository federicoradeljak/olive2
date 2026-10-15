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

    from olive.ml.model_store import WESPEAKER_MIN_SIZE

    def fake_hf_download(**_kwargs: object) -> str:
        # A complete cached file: the local-only fast path accepts it with no network.
        p = tmp_path / "wespeaker.onnx"
        if not p.is_file():
            p.write_bytes(b"x" * (WESPEAKER_MIN_SIZE + 1))
        return str(p)

    def offline(_models_dir: Path) -> None:
        raise ConnectionError("network unreachable")

    monkeypatch.setattr(huggingface_hub, "hf_hub_download", fake_hf_download)
    monkeypatch.setattr(model_store, "_download_aligner", offline)
    # Unrelated steps are stubbed so the test doesn't pay for a real
    # transformers/AutoProcessor load (seconds) inside the Cohere step.
    monkeypatch.setattr(model_store, "_download_pyannote", lambda _t: None)
    monkeypatch.setattr(model_store, "_download_cohere", lambda _t: None)

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


def test_wespeaker_uses_local_cache_without_network(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    import huggingface_hub

    from olive.ml.model_store import WESPEAKER_MIN_SIZE, _download_wespeaker

    cached = tmp_path / "wespeaker.onnx"
    cached.write_bytes(b"x" * (WESPEAKER_MIN_SIZE + 1))
    calls: list[bool] = []

    def fake_hf_download(**kwargs: object) -> str:
        local_only = bool(kwargs.get("local_files_only"))
        calls.append(local_only)
        if not local_only:
            raise AssertionError("network hf_hub_download must not run when cached")
        return str(cached)

    monkeypatch.setattr(huggingface_hub, "hf_hub_download", fake_hf_download)
    _download_wespeaker(None)
    assert calls == [True]


def test_wespeaker_falls_back_to_network_when_cache_misses(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    import huggingface_hub

    from olive.ml.model_store import _download_wespeaker

    calls: list[bool] = []

    def fake_hf_download(**kwargs: object) -> str:
        local_only = bool(kwargs.get("local_files_only"))
        calls.append(local_only)
        if local_only:
            raise FileNotFoundError("not cached")
        fetched = tmp_path / "wespeaker.onnx"
        fetched.write_bytes(b"x" * 1024)
        return str(fetched)

    monkeypatch.setattr(huggingface_hub, "hf_hub_download", fake_hf_download)
    _download_wespeaker(None)
    assert calls == [True, False]


def test_pyannote_uses_local_snapshot_without_network(monkeypatch: pytest.MonkeyPatch) -> None:
    import huggingface_hub

    from olive.ml.model_store import _download_pyannote

    calls: list[bool] = []

    def fake_snapshot(**kwargs: object) -> str:
        local_only = bool(kwargs.get("local_files_only"))
        calls.append(local_only)
        if not local_only:
            raise AssertionError("network snapshot_download must not run when cached")
        return "/cache/pyannote"

    monkeypatch.setattr(huggingface_hub, "snapshot_download", fake_snapshot)
    _download_pyannote(None)
    assert calls == [True]


def test_cohere_warm_path_avoids_transformers_import(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    import sys

    import huggingface_hub

    from olive.ml.asr_cohere import _COHERE_STAGED_MIN_SIZES
    from olive.ml.model_store import _download_cohere

    monkeypatch.setenv("OLIVE_MODELS_DIR", str(tmp_path))
    cohere_dir = tmp_path / "cohere-int8"
    cohere_dir.mkdir(parents=True)
    for name, min_size in _COHERE_STAGED_MIN_SIZES:
        (cohere_dir / name).write_bytes(b"x" * min_size)
    monkeypatch.setattr(huggingface_hub, "try_to_load_from_cache", lambda _repo, _f: "/cache/config.json")
    # Any transformers import on the warm path fails the test.
    monkeypatch.setitem(sys.modules, "transformers", None)
    _download_cohere(None)


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

    from olive.ml.model_store import WESPEAKER_MIN_SIZE

    wespeaker_file = tmp_path / "wespeaker.onnx"
    wespeaker_file.write_bytes(b"x" * (WESPEAKER_MIN_SIZE + 1))

    def fake_wespeaker(**_kwargs: object) -> str:
        ok("wespeaker")
        return str(wespeaker_file)

    monkeypatch.setattr(huggingface_hub, "hf_hub_download", fake_wespeaker)

    with pytest.raises(ModelStorageError, match="could not download Cohere"):
        download_local_models(None)
    # Parallel run: every step was attempted even though one failed.
    assert sorted(called) == ["aligner", "boom", "pyannote", "wespeaker"]
