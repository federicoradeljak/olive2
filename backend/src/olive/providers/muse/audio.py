"""WAV conversion + chunking for the Muse file endpoint.

Muse accepts mono 16-bit PCM WAV at 16/24 kHz, max 32 MB and 10 minutes per
request. At 24 kHz mono 16-bit the duration cap always binds first
(10 min ~= 28.8 MB), so chunks are split purely by duration with headroom.
"""

from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

MUSE_SAMPLE_RATE = 24000
# 9-minute chunks: headroom under the 10-minute server cap.
MUSE_MAX_CHUNK_MS = 9 * 60 * 1000

# FUTURE: silence-aware split points. Chunks currently cut on hard wall-clock
# boundaries, which can slice an utterance mid-word (one ragged boundary turn
# per chunk). Prefer cutting at the nearest >=1.5s silence within ~90s before
# the cap (ffmpeg silencedetect + fallback to the hard cut when a window has
# no usable silence, e.g. heated debate). Deliberately NOT overlap-and-stitch:
# the same audio transcribed as a chunk tail vs. head yields different wording,
# so stitching needs fuzzy matching whose failures silently duplicate or drop
# sentences — plus ~10% re-transcription overhead per chunk.


def _chunk_duration_ms(chunk_path: Path) -> int:
    import soundfile as sf

    info = sf.info(str(chunk_path))
    if not info.samplerate:
        return 0
    return int(round(info.frames / float(info.samplerate) * 1000))


def prepare_muse_wav_chunks(audio_path: str | Path) -> list[tuple[bytes, int]]:
    """Converts ``audio_path`` to 24 kHz mono WAV chunks.

    Returns ``[(wav_bytes, offset_ms), ...]`` with sequential offsets.
    Blocking (ffmpeg subprocess); call from a worker thread.
    """
    src = Path(audio_path)
    if not src.exists():
        raise FileNotFoundError(f"Audio file not found on disk at {audio_path}")
    chunk_seconds = MUSE_MAX_CHUNK_MS // 1000
    with tempfile.TemporaryDirectory(prefix="olive-muse-") as tmpdir:
        pattern = str(Path(tmpdir) / "chunk-%03d.wav")
        proc = subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(src),
                "-ac",
                "1",
                "-ar",
                str(MUSE_SAMPLE_RATE),
                "-acodec",
                "pcm_s16le",
                "-f",
                "segment",
                "-segment_time",
                str(chunk_seconds),
                "-reset_timestamps",
                "1",
                pattern,
            ],
            capture_output=True,
            check=False,
        )
        chunks = sorted(Path(tmpdir).glob("chunk-*.wav"))
        if proc.returncode != 0 or not chunks:
            err = proc.stderr.decode("utf-8", errors="replace").strip() or f"exit {proc.returncode}"
            raise RuntimeError(f"ffmpeg Muse audio conversion failed ({err})")
        out: list[tuple[bytes, int]] = []
        offset_ms = 0
        for chunk_path in chunks:
            data = chunk_path.read_bytes()
            if len(data) < 44:
                continue
            out.append((data, offset_ms))
            offset_ms += _chunk_duration_ms(chunk_path)
        if not out:
            raise RuntimeError("ffmpeg Muse audio conversion produced no usable chunks")
        return out
