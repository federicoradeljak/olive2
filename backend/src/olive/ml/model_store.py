"""Local ML model download and storage checks shared by `olive models download` and container startup."""

from __future__ import annotations

import concurrent.futures
import time
import uuid
from pathlib import Path

from ..settings import resolve_paths

# Model identifiers and staged-file checks live in this lightweight module
# (stdlib + settings only) so container preflight can verify cached models
# WITHOUT importing torch / onnxruntime / transformers, which cost seconds on
# every boot. `embed.py` and `asr_cohere.py` import these names from here.

WESPEAKER_REPO_ID = "Wespeaker/wespeaker-voxceleb-resnet293-LM"
WESPEAKER_FILENAME = "voxceleb_resnet293_LM.onnx"
# Conservative minimum size: the real file is tens of MB, so anything smaller
# is a truncated download that must be re-fetched.
WESPEAKER_MIN_SIZE = 1024 * 1024

COHERE_INT8_ONNX_REPO = "vigneshlabs/cohere-transcribe-03-2026-int8-onnx"
COHERE_PROCESSOR_REPO = "onnx-community/cohere-transcribe-03-2026-ONNX"

# Staged flat-dir filenames with conservative minimum sizes (bytes) used to
# detect a complete prior staging without hitting the HF Hub. Thresholds are
# deliberately far below the real sizes (encoder .data ~2.5G, decoder .data
# ~146M, encoder .onnx ~101M, decoder .onnx ~570K, tokens.txt ~203K) so future
# model revisions still fast-path while truncated files re-download.
_COHERE_STAGED_MIN_SIZES: tuple[tuple[str, int], ...] = (
    ("cohere-encoder.int8.onnx", 100 * 1024),
    ("cohere-encoder.int8.onnx.data", 1024 * 1024),
    ("cohere-encoder.int8.fixed.onnx.data", 1024 * 1024),
    ("cohere-decoder.int8.onnx", 100 * 1024),
    ("cohere-decoder.int8.onnx.data", 1024 * 1024),
    ("cohere-decoder.int8.fixed.onnx.data", 1024 * 1024),
    ("tokens.txt", 1024),
)

# Processor/config filenames the Cohere AutoProcessor needs. Probed via the
# local HF cache only (no transformers import, no network): if any one of them
# is cached, the processor was warmed by a previous boot.
_COHERE_PROCESSOR_CACHE_PROBES: tuple[str, ...] = (
    "preprocessor_config.json",
    "tokenizer_config.json",
    "tokenizer.json",
    "config.json",
)


def is_cohere_staged_complete(cohere_dir: Path) -> bool:
    """True when every staged file exists as a non-symlink regular file above its minimum size."""
    try:
        for name, min_size in _COHERE_STAGED_MIN_SIZES:
            p = cohere_dir / name
            if p.is_symlink() or not p.is_file():
                return False
            if p.stat().st_size < min_size:
                return False
        return True
    except OSError:
        return False


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


def _download_wespeaker(hf_token: str | None) -> None:
    import huggingface_hub

    # Fast path: resolve from the local HF cache only — no Hub round-trip.
    try:
        cached = huggingface_hub.hf_hub_download(
            repo_id=WESPEAKER_REPO_ID,
            filename=WESPEAKER_FILENAME,
            token=hf_token,
            local_files_only=True,
        )
        p = Path(cached)
        # NOTE: HF cache snapshot entries are symlinks to blobs — unlike the
        # Cohere staged dir (where ONNX Runtime rejects symlinks), the
        # WeSpeaker model loads fine from the symlinked cache path at
        # transcription time, so symlinks are accepted here.
        if p.is_file() and p.stat().st_size >= WESPEAKER_MIN_SIZE:
            return
    except Exception:
        pass
    huggingface_hub.hf_hub_download(repo_id=WESPEAKER_REPO_ID, filename=WESPEAKER_FILENAME, token=hf_token)


def _download_pyannote(hf_token: str | None) -> None:
    import huggingface_hub

    # Fast path: a fully cached snapshot resolves with no Hub round-trips.
    for repo_id in PYANNOTE_REPO_CANDIDATES:
        try:
            huggingface_hub.snapshot_download(repo_id=repo_id, local_files_only=True)
            return
        except Exception:
            continue

    candidates: list[tuple[str, str | None]] = []
    if hf_token:
        candidates.append((PYANNOTE_REPO_CANDIDATES[0], hf_token))
    candidates.append((PYANNOTE_REPO_CANDIDATES[0], None))
    candidates.append((PYANNOTE_REPO_CANDIDATES[1], None))

    last_err: Exception | None = None
    for repo_id, tok in candidates:
        try:
            huggingface_hub.snapshot_download(repo_id=repo_id, token=tok)
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
    models_dir = Path(resolve_paths().models_dir)
    if is_cohere_staged_complete(models_dir / "cohere-int8"):
        # Fast path: multi-GB INT8 blobs already staged. Confirm the small
        # processor files are in the local HF cache via a pure file lookup —
        # no transformers import (seconds) and no Hub round-trips. If the
        # processor was ever evicted, the fall-through re-fetches only the
        # missing KB-sized files (INT8 staging fast-paths inside).
        try:
            from huggingface_hub import try_to_load_from_cache

            for probe in _COHERE_PROCESSOR_CACHE_PROBES:
                try:
                    if try_to_load_from_cache(COHERE_PROCESSOR_REPO, probe) is not None:
                        return
                except Exception:
                    continue
        except Exception:
            pass
    # Slow path (first boot, or evicted cache): heavy imports happen only here.
    from transformers import AutoProcessor

    from .asr_cohere import stage_cohere_int8_model_dir

    AutoProcessor.from_pretrained(COHERE_PROCESSOR_REPO, token=hf_token)
    stage_cohere_int8_model_dir(hf_token)


def download_local_models(hf_token: str | None) -> None:
    """Download (or verify from cache) every local model. Raises ModelStorageError with the failing model."""
    models_dir = Path(resolve_paths().models_dir)
    steps = [
        (
            f"WeSpeaker model ({WESPEAKER_REPO_ID})",
            lambda: _download_wespeaker(hf_token),
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
        print(f"Verifying {label}...", flush=True)
    # Run the four model checks concurrently: each is file I/O bound on a warm
    # boot (local cache probes) and they share nothing, so wall time drops
    # from the sum to roughly the slowest single step.
    started = time.monotonic()
    elapsed: dict[str, float] = {}
    failures: dict[str, Exception] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(steps)) as pool:
        future_to_label = {pool.submit(fetch): label for label, fetch in steps}
        for future in concurrent.futures.as_completed(future_to_label):
            label = future_to_label[future]
            elapsed[label] = time.monotonic() - started
            try:
                future.result()
            except Exception as exc:
                failures[label] = exc
    for label, _fetch in steps:
        status = "FAILED" if label in failures else "ready"
        print(f"{status} {label} ({elapsed.get(label, 0.0):.1f}s)", flush=True)
    for label, _fetch in steps:
        if label in failures:
            raise ModelStorageError(f"could not download {label}: {failures[label]}") from failures[label]
    print(f"All local ML models are available ({time.monotonic() - started:.1f}s total).", flush=True)
