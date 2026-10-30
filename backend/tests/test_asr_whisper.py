"""Whisper ASR backend, ASR registry, device selection and native-timestamp pipeline path."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest

import olive.ml.asr_whisper as asr_whisper
from olive.ml.asr_registry import build_asr_engine, normalize_asr_model
from olive.ml.asr_whisper import FasterWhisperAsrEngine
from olive.ml.device import onnx_providers, resolve_device
from olive.ml.pipeline import LocalTranscriptionPipeline
from olive.ml.protocols import LocalSpeakerSegment
from olive.schemas import TranscriptWord


class _FakeWhisperModel:
    instances: list[_FakeWhisperModel] = []

    def __init__(self, name: str, **kwargs: Any) -> None:
        self.name = name
        self.kwargs = kwargs
        self.calls: list[dict[str, Any]] = []
        _FakeWhisperModel.instances.append(self)

    def transcribe(self, samples: np.ndarray, **kwargs: Any) -> tuple[Any, Any]:
        self.calls.append(kwargs)
        words = [
            SimpleNamespace(word=" Hola", start=0.1, end=0.4, probability=0.9),
            SimpleNamespace(word=" mundo", start=0.5, end=0.9, probability=0.8),
        ]
        return iter([SimpleNamespace(text=" Hola mundo", words=words)]), SimpleNamespace(language="es")


@pytest.fixture
def fake_whisper(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> type[_FakeWhisperModel]:
    _FakeWhisperModel.instances = []
    monkeypatch.setattr(asr_whisper, "_whisper_model_class", lambda: _FakeWhisperModel)
    monkeypatch.setenv("OLIVE_MODELS_DIR", str(tmp_path / "models"))
    return _FakeWhisperModel


def test_device_defaults_to_cpu(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OLIVE_ML_DEVICE", raising=False)
    assert resolve_device() == "cpu"
    assert onnx_providers() == ["CPUExecutionProvider"]
    monkeypatch.setenv("OLIVE_ML_DEVICE", "cuda")
    assert resolve_device() == "cuda"
    assert onnx_providers() == ["CUDAExecutionProvider", "CPUExecutionProvider"]


def test_registry_validates_names() -> None:
    assert normalize_asr_model(None) == "cohere"
    assert normalize_asr_model(" Whisper-Large-V3 ") == "whisper-large-v3"
    with pytest.raises(ValueError, match="Unknown ASR model"):
        normalize_asr_model("whisper-tiny")
    engine = build_asr_engine("whisper-large-v3-turbo")
    assert isinstance(engine, FasterWhisperAsrEngine)
    assert engine.provides_word_timestamps is True


async def test_whisper_engine_offsets_words_and_auto_detects_language(
    fake_whisper: type[_FakeWhisperModel],
) -> None:
    engine = FasterWhisperAsrEngine("whisper-large-v3-turbo", {"device": "cuda"})
    res = await engine.transcribe_segment(
        np.zeros(16000, dtype=np.float32), 16000, {"startMs": 1000, "language": "auto"}
    )

    assert res["text"] == "Hola mundo"
    assert [(w.word, w.startMs, w.endMs) for w in res["words"]] == [
        ("Hola", 1100, 1400),
        ("mundo", 1500, 1900),
    ]
    model = fake_whisper.instances[0]
    assert model.name == "large-v3-turbo"
    assert model.kwargs["compute_type"] == "float16"
    assert model.calls[0]["language"] is None
    assert model.calls[0]["word_timestamps"] is True
    assert model.calls[0]["hotwords"] is None


async def test_whisper_engine_passes_custom_vocabulary_as_hotwords(
    fake_whisper: type[_FakeWhisperModel],
) -> None:
    engine = FasterWhisperAsrEngine("whisper-large-v3-turbo", {"device": "cpu"})
    await engine.transcribe_segment(
        np.zeros(16000, dtype=np.float32), 16000, {"additionalVocab": ["Olive", " ", "Plaud"]}
    )

    assert fake_whisper.instances[0].calls[0]["hotwords"] == "Olive, Plaud"


class _FakeDiarizer:
    async def diarize(self, samples: Any, sample_rate: int = 16000, *_args: Any, **_kwargs: Any) -> list[Any]:
        return [
            LocalSpeakerSegment(
                startMs=0, endMs=1000, speakerId="Speaker 1", samples=samples[:16000], embedding=[]
            ),
            LocalSpeakerSegment(
                startMs=1000, endMs=2000, speakerId="Speaker 2", samples=samples[16000:], embedding=[]
            ),
        ]

    def release(self) -> None:
        pass


class _NativeAsr:
    provides_word_timestamps = True

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def transcribe_segment(
        self, samples: Any, sample_rate: int = 16000, options: Any = None
    ) -> dict[str, Any]:
        self.calls.append(dict(options or {}))
        return {
            "text": "hola chau",
            "words": [
                TranscriptWord(word="hola", startMs=100, endMs=500),
                TranscriptWord(word="chau", startMs=1200, endMs=1600),
            ],
        }

    def release(self) -> None:
        pass


class _ExplodingAligner:
    async def align(self, *_args: Any, **_kwargs: Any) -> list[TranscriptWord]:
        raise AssertionError("aligner must not run for native-timestamp ASR")

    def release(self) -> None:
        pass


async def test_pipeline_uses_native_word_timestamps_without_aligner(monkeypatch: pytest.MonkeyPatch) -> None:
    import olive.ml.pipeline as pipeline_mod

    async def _fake_load(_opts: Any, _sr: int) -> Any:
        return SimpleNamespace(samples=np.zeros(32000, dtype=np.float32), duration_ms=2000)

    monkeypatch.setattr(pipeline_mod, "load_audio_samples", _fake_load)
    asr = _NativeAsr()
    pipeline = LocalTranscriptionPipeline(
        {"unloadPerStage": False},
        custom_diarizer=_FakeDiarizer(),
        custom_extractor=SimpleNamespace(dim=256, release=lambda: None),
        custom_asr_engine=asr,
        custom_aligner=_ExplodingAligner(),
    )
    result = await pipeline.transcribe(
        {
            "audioPath": "unused.flac",
            "language": "auto",
            "enrolledSpeakers": [],
            "additionalVocab": ["Olive"],
        }
    )

    assert len(asr.calls) == 1  # one whole-file pass, not one per turn
    assert asr.calls[0]["additionalVocab"] == ["Olive"]
    assert [(s.speaker, s.text) for s in result.transcript.segments] == [
        ("Speaker 1", "hola"),
        ("Speaker 2", "chau"),
    ]
    assert set(pipeline.last_timings) >= {"diarizeSec", "asrSec"}


def test_diarizer_runs_without_dbos_runtime(monkeypatch: pytest.MonkeyPatch) -> None:
    """The Modal GPU worker has no dbos; diarize's shutdown check must not import-fail."""
    import sys

    import olive.ml.diarize as diarize_mod

    diarize_mod._shutdown_probe.cache_clear()
    monkeypatch.setitem(sys.modules, "olive.workflows.runtime", None)  # import -> ImportError
    try:
        assert diarize_mod._server_shutting_down() is False
    finally:
        diarize_mod._shutdown_probe.cache_clear()
