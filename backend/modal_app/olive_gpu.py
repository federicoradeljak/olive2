"""Olive GPU worker on Modal.com: runs the local ML pipeline on a cloud GPU.

The server's ``modal`` transcription provider (``olive.providers.modal``) looks
this app up by name and calls ``OliveGpu.transcribe``. It returns a transcript
with generic ``Speaker N`` clusters; voiceprint matching stays on the server.

Setup (from ``backend/``):

    uv run modal token new
    uv run modal secret create olive-hf HF_TOKEN=hf_...
    uv run modal run modal_app/olive_gpu.py::warm_models      # one-off model download
    OLIVE_MODAL_GPU=L4,T4,A10G uv run modal deploy modal_app/olive_gpu.py

``OLIVE_MODAL_GPU`` is read at deploy time: a comma-separated preference list
(Modal falls back to the next type when one has no capacity). Models are
cached in the ``olive-models`` volume, so cold starts only load weights.
"""

from __future__ import annotations

import os
import tempfile
import time
from typing import Any

import modal

APP_NAME = "olive-gpu"
GPU_PREFERENCE = [g.strip() for g in os.environ.get("OLIVE_MODAL_GPU", "L4,T4,A10G").split(",") if g.strip()]
# Names as Modal prices them; matched against torch's device name at runtime.
KNOWN_GPUS = ("L40S", "L4", "A10G", "A10", "T4", "A100", "H100")


def _current_gpu() -> str:
    """The GPU type this container actually got (for cost estimates)."""
    import torch

    name = torch.cuda.get_device_name(0).upper() if torch.cuda.is_available() else ""
    return next((g for g in KNOWN_GPUS if g in name), name or "unknown")


MODELS_DIR = "/models"

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("ffmpeg", "libsndfile1")
    .pip_install(
        "torch==2.14.1",
        "torchaudio==2.11.0",  # torchaudio versions lag torch; matches uv.lock
        "pyannote-audio==4.0.7",
        "transformers==5.19.0",
        "ctc-forced-aligner==1.0.2",
        "faster-whisper>=1.1.0",
        "huggingface-hub",
        "soundfile",
        "numpy>=2.0.0",
        "scipy",
        "scikit-learn",
        "pydantic>=2.10.0",
        "sqlalchemy>=2.0.36",
    )
    # Some of the above pull the CPU onnxruntime wheel; it shadows the GPU one.
    .run_commands(
        "pip uninstall -y onnxruntime || true",
        "pip install --force-reinstall 'onnxruntime-gpu>=1.20.0'",
    )
    # CTranslate2 (faster-whisper) and onnxruntime-gpu link against CUDA 12 +
    # cuDNN 9, which torch's own CUDA wheels may not provide. Install the CUDA 12
    # runtime libs as wheels and register every nvidia/*/lib dir with the linker.
    .pip_install(
        "nvidia-cuda-runtime-cu12",
        "nvidia-cuda-nvrtc-cu12",
        "nvidia-cublas-cu12",
        "nvidia-cufft-cu12",
        "nvidia-curand-cu12",
        "nvidia-cudnn-cu12>=9,<10",
    )
    .run_commands(
        'python -c "import glob, sysconfig; '
        "d = sysconfig.get_paths()['purelib']; "
        "open('/etc/ld.so.conf.d/nvidia-pip.conf', 'w').write(chr(10).join(sorted(glob.glob(d + '/nvidia/*/lib'))))\"",
        "ldconfig",
        "ldconfig -p | grep -E 'libcublas\\.so\\.12|libcudnn\\.so\\.9'",
    )
    .env(
        {
            "OLIVE_ML_DEVICE": "cuda",
            "OLIVE_MODELS_DIR": MODELS_DIR,
            "OLIVE_CONFIG_DIR": "/tmp/olive-config",
            "HF_HOME": f"{MODELS_DIR}/huggingface",
        }
    )
    .add_local_python_source("olive")
)

app = modal.App(APP_NAME, image=image)
models_volume = modal.Volume.from_name("olive-models", create_if_missing=True)
hf_secret = modal.Secret.from_name("olive-hf")


@app.function(volumes={MODELS_DIR: models_volume}, secrets=[hf_secret], timeout=3600)
def warm_models(asr_models: str = "whisper-large-v3-turbo,whisper-large-v3") -> None:
    """Downloads every model into the volume (CPU only, no GPU billed)."""
    from olive.ml.asr_whisper import WHISPER_MODEL_NAMES, whisper_download_root
    from olive.ml.model_store import download_local_models
    from olive.settings import get_effective_hf_token

    download_local_models(get_effective_hf_token())
    from faster_whisper.utils import download_model  # pyright: ignore[reportMissingImports]

    for name in [m.strip() for m in asr_models.split(",") if m.strip()]:
        print(f"Downloading {name}...", flush=True)
        download_model(WHISPER_MODEL_NAMES[name], cache_dir=whisper_download_root())
    models_volume.commit()


@app.cls(
    gpu=GPU_PREFERENCE,
    volumes={MODELS_DIR: models_volume},
    secrets=[hf_secret],
    timeout=3600,
    scaledown_window=60,
)
class OliveGpu:
    @modal.enter()
    def load(self) -> None:
        import onnxruntime as ort

        from olive.ml.diarize import PyannoteSpeakerDiarizer
        from olive.ml.embed import WeSpeakerEmbeddingExtractor

        try:
            import ctranslate2  # pyright: ignore[reportMissingImports]

            ct2_gpus = ctranslate2.get_cuda_device_count()
        except Exception as exc:
            ct2_gpus = f"error: {exc}"
        print(
            f"GPU {_current_gpu()} | onnxruntime providers {ort.get_available_providers()} | "
            f"ctranslate2 CUDA devices {ct2_gpus}",
            flush=True,
        )

        t0 = time.perf_counter()
        self.extractor = WeSpeakerEmbeddingExtractor()
        self.diarizer = PyannoteSpeakerDiarizer(self.extractor, {})
        self.asr_engines: dict[str, Any] = {}
        # Container set-up is billed once; charge it to the first call (model
        # weights load lazily inside the first call's runSec).
        self.pending_load_sec = time.perf_counter() - t0

    def _asr_engine(self, name: str) -> Any:
        from olive.ml.asr_registry import build_asr_engine, normalize_asr_model

        key = normalize_asr_model(name)
        if key not in self.asr_engines:
            self.asr_engines[key] = build_asr_engine(key)
        return self.asr_engines[key]

    @modal.method()
    async def transcribe(self, audio_bytes: bytes, options: dict[str, Any]) -> dict[str, Any]:
        from olive.ml.pipeline import LocalTranscriptionPipeline

        t0 = time.perf_counter()
        asr_model = str(options.get("asrModel") or "cohere")
        engine = self._asr_engine(asr_model)
        pipeline = LocalTranscriptionPipeline(
            {"unloadPerStage": False},
            custom_diarizer=self.diarizer,
            custom_extractor=self.extractor,
            custom_asr_engine=engine,
        )
        with tempfile.NamedTemporaryFile(suffix=".flac") as tmp:
            tmp.write(audio_bytes)
            tmp.flush()
            result = await pipeline.transcribe(
                {
                    "audioPath": tmp.name,
                    # The pipeline defaults to "en"; Whisper should auto-detect instead.
                    "language": options.get("language")
                    or ("auto" if getattr(engine, "provides_word_timestamps", False) else None),
                    "modelId": options.get("modelId"),
                    "wholeFileAsr": bool(options.get("wholeFileAsr")),
                    "expectedSpeakerCount": options.get("expectedSpeakerCount"),
                    "clusteringThreshold": options.get("clusteringThreshold"),
                    "additionalVocab": options.get("additionalVocab"),
                    "enrolledSpeakers": [],
                }
            )
        load_sec, self.pending_load_sec = self.pending_load_sec, 0.0
        return {
            "transcript": result.transcript.model_dump(exclude_none=True),
            "asrModel": asr_model,
            "gpu": _current_gpu(),
            "timings": {
                **pipeline.last_timings,
                "loadSec": round(load_sec, 3),
                "runSec": round(time.perf_counter() - t0, 3),
            },
        }
