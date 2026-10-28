"""Audio preparation for the Modal GPU worker.

The worker re-decodes to 16 kHz mono anyway, so the upload is downsampled to
that rate and FLAC-compressed (~1/4 of the PCM size, lossless at 16 kHz).
"""

from __future__ import annotations

import subprocess
from pathlib import Path


def prepare_modal_flac(audio_path: str | Path) -> bytes:
    """Converts ``audio_path`` to 16 kHz mono FLAC bytes. Blocking (ffmpeg)."""
    src = Path(audio_path)
    if not src.exists():
        raise FileNotFoundError(f"Audio file not found on disk at {audio_path}")
    proc = subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(src),
            "-ac",
            "1",
            "-ar",
            "16000",
            "-f",
            "flac",
            "pipe:1",
        ],
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0 or not proc.stdout:
        detail = proc.stderr.decode("utf-8", "replace").strip()[:300]
        raise RuntimeError(f"ffmpeg could not convert audio for Modal: {detail or 'empty output'}")
    return proc.stdout
