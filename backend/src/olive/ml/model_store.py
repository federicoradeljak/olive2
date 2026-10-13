"""Local ML model download and storage checks shared by `olive models download` and container startup."""

from __future__ import annotations

import uuid
from pathlib import Path

from ..settings import resolve_paths
from .asr_cohere import COHERE_INT8_ONNX_REPO, COHERE_PROCESSOR_REPO, stage_cohere_int8_model_dir
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
    from ctc_forced_aligner import MODEL_URL, ensure_onnx_model

    align_dir = models_dir / "aligner"
    align_dir.mkdir(parents=True, exist_ok=True)
    ensure_onnx_model(str(align_dir / "mms-300m-aligner.onnx"), MODEL_URL)


def _download_cohere(hf_token: str | None) -> None:
    from transformers import AutoProcessor

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
    for label, fetch in steps:
        print(f"Downloading {label}...", flush=True)
        try:
            fetch()
        except Exception as exc:
            raise ModelStorageError(f"could not download {label}: {exc}") from exc
    print("All local ML models are available.", flush=True)
