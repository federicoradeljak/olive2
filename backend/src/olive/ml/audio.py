"""Audio decoding, resampling, encoding, and FFmpeg speech enhancement (port of wav.ts)."""

from __future__ import annotations

import asyncio
import io
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf

_ENHANCE_LOCKS: dict[str, asyncio.Lock] = {}

SPEECH_ENHANCEMENT_FILTER = (
    "highpass=f=80,afftdn=nr=10:nf=-35:tn=1,"
    "equalizer=f=350:t=q:w=1.5:g=-3,"
    "equalizer=f=3200:t=q:w=1.2:g=5,"
    "speechnorm=e=4:r=0.0001:l=1"
)


@dataclass
class DecodedWav:
    samples: np.ndarray  # 1-D float32 mono samples in [-1.0, 1.0]
    sample_rate: int
    channels: int
    duration_ms: int

    @property
    def sampleRate(self) -> int:
        return self.sample_rate

    @property
    def durationMs(self) -> int:
        return self.duration_ms


def is_wav(buffer: bytes | bytearray | memoryview | None) -> bool:
    if not buffer or len(buffer) < 12:
        return False
    b = bytes(buffer[:12])
    return b[:4] == b"RIFF" and b[8:12] == b"WAVE"


def decode_wav(buffer: bytes | bytearray | memoryview) -> DecodedWav:
    raw = bytes(buffer)
    if len(raw) < 44 or not is_wav(raw):
        raise ValueError("Invalid WAV: expected RIFF/WAVE header")

    data, sr = sf.read(io.BytesIO(raw), dtype="float32", always_2d=True)
    channels = int(data.shape[1])
    mono = data.mean(axis=1).astype(np.float32) if channels > 1 else data[:, 0].astype(np.float32)
    duration_ms = int(round((len(mono) / float(sr)) * 1000))
    return DecodedWav(
        samples=mono,
        sample_rate=int(sr),
        channels=channels,
        duration_ms=duration_ms,
    )


def resample(
    samples: np.ndarray,
    source_sample_rate: int,
    target_sample_rate: int = 16000,
) -> np.ndarray:
    arr = np.asarray(samples, dtype=np.float32)
    if source_sample_rate == target_sample_rate or len(arr) == 0:
        return arr

    ratio = source_sample_rate / float(target_sample_rate)
    target_length = int(round(len(arr) / ratio))
    if target_length <= 0:
        return np.zeros(0, dtype=np.float32)

    orig_pos = np.arange(target_length, dtype=np.float64) * ratio
    idx0 = np.floor(orig_pos).astype(np.int64)
    frac = (orig_pos - idx0).astype(np.float32)
    idx0 = np.clip(idx0, 0, len(arr) - 1)
    idx1 = np.clip(idx0 + 1, 0, len(arr) - 1)
    return (arr[idx0] + (arr[idx1] - arr[idx0]) * frac).astype(np.float32)


def encode_wav(samples: np.ndarray | list[float], sample_rate: int = 16000) -> bytes:
    arr = np.asarray(samples, dtype=np.float32)
    arr = np.clip(arr, -1.0, 1.0)
    buf = io.BytesIO()
    sf.write(buf, arr, sample_rate, subtype="PCM_16", format="WAV")
    return buf.getvalue()


def enhance_audio_file(source_path: str | Path, target_path: str | Path) -> bool:
    src = Path(source_path)
    dst = Path(target_path)
    if not src.exists():
        return False
    if dst.exists() and dst.stat().st_size > 0:
        return True
    tmp_dst = dst.with_name(f"{dst.stem}.{os.getpid()}.tmp{dst.suffix or '.mp3'}")
    try:
        dst.parent.mkdir(parents=True, exist_ok=True)
        proc = subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(src),
                "-af",
                SPEECH_ENHANCEMENT_FILTER,
                "-c:a",
                "libmp3lame",
                "-b:a",
                "128k",
                str(tmp_dst),
            ],
            capture_output=True,
            check=False,
        )
        if proc.returncode == 0 and tmp_dst.exists() and tmp_dst.stat().st_size > 0:
            os.replace(tmp_dst, dst)
            return True
        return False
    except Exception:
        return False
    finally:
        try:
            tmp_dst.unlink(missing_ok=True)
        except OSError:
            pass


async def enhance_audio_file_async(source_path: str | Path, target_path: str | Path) -> bool:
    src = Path(source_path)
    dst = Path(target_path)
    if not src.exists():
        return False
    if dst.exists() and dst.stat().st_size > 0:
        return True

    key = str(dst.resolve())
    lock = _ENHANCE_LOCKS.get(key)
    if lock is None:
        lock = asyncio.Lock()
        _ENHANCE_LOCKS[key] = lock

    async with lock:
        if dst.exists() and dst.stat().st_size > 0:
            return True
        return await asyncio.to_thread(enhance_audio_file, src, dst)


def _load_audio_samples_sync(
    audio_path: str | Path | None = None,
    audio_bytes: bytes | None = None,
    enhance: bool | None = None,
    target_sample_rate: int = 16000,
) -> DecodedWav:
    if audio_bytes is not None and is_wav(audio_bytes) and enhance is not True:
        decoded = decode_wav(audio_bytes)
        if decoded.sample_rate != target_sample_rate:
            decoded = DecodedWav(
                samples=resample(decoded.samples, decoded.sample_rate, target_sample_rate),
                sample_rate=target_sample_rate,
                channels=decoded.channels,
                duration_ms=decoded.duration_ms,
            )
        return decoded

    if audio_path is not None and Path(audio_path).exists() and enhance is not True:
        try:
            raw = Path(audio_path).read_bytes()
            if is_wav(raw):
                decoded = decode_wav(raw)
                if decoded.sample_rate != target_sample_rate:
                    decoded = DecodedWav(
                        samples=resample(decoded.samples, decoded.sample_rate, target_sample_rate),
                        sample_rate=target_sample_rate,
                        channels=decoded.channels,
                        duration_ms=decoded.duration_ms,
                    )
                return decoded
        except Exception:
            pass

    args = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
    stdin_data: bytes | None = None
    if audio_path is not None and Path(audio_path).exists():
        args.extend(["-i", str(audio_path)])
    elif audio_bytes is not None:
        args.extend(["-i", "pipe:0"])
        stdin_data = bytes(audio_bytes)
    else:
        raise ValueError("Either audio_path or audio_bytes must be provided")

    if enhance is not False:
        args.extend(["-af", SPEECH_ENHANCEMENT_FILTER])

    args.extend(
        [
            "-f",
            "wav",
            "-acodec",
            "pcm_s16le",
            "-ac",
            "1",
            "-ar",
            str(target_sample_rate),
            "pipe:1",
        ]
    )

    proc = subprocess.run(
        args,
        input=stdin_data,
        capture_output=True,
        check=False,
    )
    if proc.returncode == 0 and len(proc.stdout) >= 44:
        return decode_wav(proc.stdout)

    err_msg = proc.stderr.decode("utf-8", errors="replace").strip() or f"exit code {proc.returncode}"
    raise RuntimeError(f"ffmpeg audio conversion failed ({err_msg})")


async def load_audio_samples(
    input_opts: dict[str, Any] | None = None,
    target_sample_rate: int = 16000,
    *,
    audio_path: str | Path | None = None,
    audio_bytes: bytes | None = None,
    enhance: bool | None = None,
) -> DecodedWav:
    if input_opts:
        audio_path = audio_path or input_opts.get("audioPath") or input_opts.get("audio_path")
        audio_bytes = audio_bytes or input_opts.get("audioBytes") or input_opts.get("audio_bytes")
        if enhance is None and "enhance" in input_opts:
            enhance = input_opts.get("enhance")
    return await asyncio.to_thread(
        _load_audio_samples_sync,
        audio_path=audio_path,
        audio_bytes=audio_bytes,
        enhance=enhance,
        target_sample_rate=target_sample_rate,
    )
