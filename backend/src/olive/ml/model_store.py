"""Local ML model download and storage checks shared by `olive models download` and container startup."""

from __future__ import annotations

import concurrent.futures
import uuid
from pathlib import Path

from ..settings import resolve_paths
from .asr_cohere import (
    COHERE_INT8_ONNX_REPO,
    COHERE_PROCESSOR_REPO,
    is_cohere_staged_complete,
    stage_cohere_int8_model_dir,
)
from .embed import WESPEAKER_FILENAME, WESPEAKER_REPO_ID

PYANNOTE_REPO_CANDIDATES = (
    "pyannote/speaker-diarization-community-1",
    "pyannote-community/speaker-diarization-community-1",
)


class ModelStorageError(RuntimeError):
    """A local model directory is unusable or a model could not be downloaded. Message is user-facing."""


def ensure_models_volume(models_dir: Path) -> None:
    """Require models_dir to be a separate mounted volume that the process can write to."""
    path = models_dir.resolve()
    mount_hint = f"mount a persistent volume there (e.g. -v olive_models:{path})"
    if not path.is_dir():
        raise ModelStorageError(f"models directory {path} does not exist; {mount_hint}")

    # A mount point has a different device id than its parent directory.
    if path.stat().st_dev == path.parent.stat().st_dev:
        raise ModelStorageError(
            f"models directory {path} is not a mounted volume, so models would be lost on "
            f"upgrade; {mount_hint}"
        )

    probe = path / f".olive-write-check-{uuid.uuid4().hex}"
    try:
        probe.touch()
        probe.unlink()
    except OSError as exc:
        raise ModelStorageError(
            f"models directory {path} is not writable ({exc.strerror or exc}); "
            "check the volume mount and its permissions"
        ) from exc


def _aligner_model_path(models_dir: Path) -> Path:
    return models_dir / "aligner" / "mms-300m-aligner.onnx"


def _is_aligner_staged(models_dir: Path) -> bool:
    """True when the MMS aligner ONNX already exists locally (real download is ~1.2G)."""
    try:
        p = _aligner_model_path(models_dir)
        return p.is_file() and not p.is_symlink() and p.stat().st_size >= 1024 * 1024
    except OSError:
        return False


def _download_pyannote(hf_token: str | None) -> None:
    from huggingface_hub import snapshot_download

    candidates: list[tuple[str, str | None]] = []
    if hf_token:
        candidates.append((PYANNOTE_REPO_CANDIDATES[0], hf_token))
    candidates.append((PYANNOTE_REPO_CANDIDATES[0], None))
    candidates.append((PYANNOTE_REPO_CANDIDATES[1], None))

    last_err: Exception | None = None
    for repo_id, tok in candidates:
        try:
            snapshot_download(repo_id=repo_id, token=tok)
            return
        except Exception as exc:
            last_err = exc
    assert last_err is not None
    raise last_err


def _download_aligner(models_dir: Path) -> None:
    # Fast path: already staged from a previous boot — skip the import and any
    # network check entirely (`ensure_onnx_model` also skips existing files,
    # but importing the package still costs time on every container start).
    if _is_aligner_staged(models_dir):
        return
    from ctc_forced_aligner import MODEL_URL, ensure_onnx_model

    align_dir = models_dir / "aligner"
    align_dir.mkdir(parents=True, exist_ok=True)
    ensure_onnx_model(str(_aligner_model_path(models_dir)), MODEL_URL)


def _download_cohere(hf_token: str | None) -> None:
    from transformers import AutoProcessor

    # Fast path: INT8 files already staged — verify the processor from local
    # cache only, with no HF Hub round-trips. Falls through to the network
    # path when the processor is not cached yet.
    cohere_dir = Path(resolve_paths().models_dir) / "cohere-int8"
    if is_cohere_staged_complete(cohere_dir):
        try:
            AutoProcessor.from_pretrained(COHERE_PROCESSOR_REPO, token=hf_token, local_files_only=True)
            return
        except Exception:
            pass
    AutoProcessor.from_pretrained(COHERE_PROCESSOR_REPO, token=hf_token)
    stage_cohere_int8_model_dir(hf_token)


def download_local_models(hf_token: str | None) -> None:
    """Download (or verify from cache) every local model. Raises ModelStorageError with the failing model."""
    from huggingface_hub import hf_hub_download

    models_dir = Path(resolve_paths().models_dir)
    steps = [
        (
            f"WeSpeaker model ({WESPEAKER_REPO_ID})",
            lambda: hf_hub_download(repo_id=WESPEAKER_REPO_ID, filename=WESPEAKER_FILENAME, token=hf_token),
        ),
        (
            "ctc-forced-aligner MMS-300m ONNX model",
            lambda: _download_aligner(models_dir),
        ),
        (
            "pyannote speaker-diarization-community-1",
            lambda: _download_pyannote(hf_token),
        ),
        (
            f"Cohere Transcribe 03-2026 INT8 ONNX ({COHERE_INT8_ONNX_REPO})",
            lambda: _download_cohere(hf_token),
        ),
    ]
    for label, _fetch in steps:
        print(f"Downloading {label}...", flush=True)
    # Run the four model checks concurrently: each is network/file I/O bound
    # (HF Hub metadata + file staging) and they share nothing, so wall time
    # drops from the sum to roughly the slowest single step.
    failures: dict[str, Exception] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(steps)) as pool:
        future_to_label = {pool.submit(fetch): label for label, fetch in steps}
        for future in concurrent.futures.as_completed(future_to_label):
            try:
                future.result()
            except Exception as exc:
                failures[future_to_label[future]] = exc
    for label, _fetch in steps:
        if label in failures:
            raise ModelStorageError(f"could not download {label}: {failures[label]}") from failures[label]
    print("All local ML models are available.", flush=True)
