# Local ML hardware acceleration (Apple Silicon and Vulkan)

Apple Silicon (`mps` / `CoreML`) is worth doing and should cut a 60-minute local transcription job from ~7-10 minutes on CPU down to ~2 minutes. Vulkan is not viable for our current PyTorch and ONNX Runtime model stack.

## Current model execution

All local transcription stages run sequentially inside a spawned worker process (`backend/src/olive/ml/worker.py`) with `unloadPerStage=True` (`backend/src/olive/ml/pipeline.py`). Every stage is currently hardcoded to CPU.

| Stage | File | Model | Runtime | Current config | Share of 60m job |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1. Diarization | `ml/diarize.py` | `pyannote/speaker-diarization-community-1` (PyanNet SincNet + BiLSTM + ResNet34 + VBx) | PyTorch (`fp32`) | `pipe.to(torch.device("cpu"))` | ~30-45% (~2-4m) |
| 2. Voiceprints | `ml/embed.py` | `Wespeaker/wespeaker-voxceleb-resnet293-LM` (`voxceleb_resnet293_LM.onnx`) | `torchaudio.compliance.kaldi.fbank` + ONNX Runtime (`fp32`) | `providers=["CPUExecutionProvider"]` | <3% (~5-10s) |
| 3. ASR | `ml/asr_cohere.py` | `vigneshlabs/cohere-transcribe-03-2026-int8-onnx` (~2B Conformer encoder + Transformer decoder) | `AutoProcessor` + ONNX Runtime (`int8`) | `providers=["CPUExecutionProvider"]` | ~50-65% (~4-6m) |
| 4. Forced alignment | `ml/align.py` | `MahmoudAshraf/mms-300m-1130-forced-aligner` | ONNX Runtime (`fp32`) | `providers=["CPUExecutionProvider"]` | 0% by default (only runs when `wholeFileAsr=True`) |

Note on `backend/pyproject.toml`: `torch` and `torchaudio` only pin the `pytorch-cpu` index when `sys_platform == 'linux'`. On macOS, `uv` already installs standard PyPI wheels with Metal Performance Shaders (`mps`) compiled in.

## Where runtime actually goes

1. **Cohere ASR (~50-65% of wall time).** `CohereAsrEngine._transcribe_chunk_int8_sync` has two phases per 30s audio window:
   - **Encoder forward pass (`cohere-encoder.int8.onnx`).** Single pass over the mel spectrogram. Compute-bound and scales well on a GPU.
   - **Greedy decoder loop (`cohere-decoder.int8.onnx`).** Runs `self._decoder_sess.run(...)` once per generated token in Python, passing `self_k`, `self_v`, `cross_k`, and `cross_v` (~65 MB of `float32` KV cache) across the Python/C++ boundary on every step. On a GPU without ONNX `IOBinding` (or an in-graph loop), copying 65 MB between host RAM and device memory on every token is slower than running on CPU.
2. **Pyannote diarization (~30-45% of wall time).**
   - Segmentation runs sliding windows over the audio (`step=2.5s`).
   - Speaker embedding extraction runs batched ResNet inference (`embedding_batch_size=32`) over active speaker windows. This is batched 2D convolution and is heavily compute-bound on CPU.
   - VBx clustering runs in NumPy/SciPy on CPU and takes <2s.
3. **WeSpeaker 256-d voiceprints (<3% of wall time).** `diarize.py` caps extraction at `MAX_VOICEPRINT_TURNS_PER_CLUSTER = 8` (up to 12s each). A 4-speaker meeting runs WeSpeaker at most 32 times (~330ms each on CPU, ~10s total). Accelerating this saves at most a few seconds per meeting.
4. **CTC forced aligner (0% in default mode).** `pipeline.py` only calls `CtcForcedAligner` when `wholeFileAsr=True`, which `TranscriptionService` does not enable by default. Normal per-turn transcription uses `proportional_word_timestamps()`.

## Target 1: Apple Silicon (`mps` and `CoreML`)

Apple Silicon is well worth targeting, using PyTorch `mps` rather than ONNX `CoreMLExecutionProvider` for the heavy models.

### Pyannote diarization on `mps` (high value, low effort)
- `pyannote.audio` 4.x supports `pipe.to(torch.device("mps"))` out of the box with our current macOS `torch` dependency.
- **Required code change in `ml/diarize.py`:** Our `_fast_get_embeddings` monkeypatch (`ml/diarize.py:130`) builds `w_batch` and `m_batch` from CPU tensors. Make sure `pipe._embedding` receives tensors on the expected device (or let `pyannote` handle device placement), and bump `embedding_batch_size` from `32` to `64` or `128` when running on `mps`.
- **Expected speedup:** 3x-6x faster diarization on M1/M2/M3/M4 Macs.

### Cohere ASR on `mps` via PyTorch `transformers` (high value, medium effort)
- **Do not put `cohere-*.int8.onnx` on `CoreMLExecutionProvider`.** The INT8 ONNX export relies on `DynamicQuantizeLinear` and `MatMulInteger` nodes. CoreML EP does not support dynamic integer quantization ops cleanly, so ONNX Runtime splits the graph into dozens of partitions and copies tensors between CPU and Neural Engine/GPU multiple times per layer. Combined with the Python KV-cache loop, `CoreMLExecutionProvider` on the INT8 graph is slower than `CPUExecutionProvider`.
- **Use `CohereAsrForConditionalGeneration` on `mps` (`float16` or `bfloat16`) instead.** `ml/asr_cohere.py` already defines `COHERE_TORCH_UNGATED_REPO = "evewashere/cohere-transcribe-03-2026-ungated"` and `self._torch_model`, and `transformers>=5.4.0` is already in `pyproject.toml`. Implementing the PyTorch `.generate()` path on `mps` in `fp16`/`bf16` keeps the KV cache resident on the GPU across decoding steps.
- **Memory footprint:** ~4 GB in `fp16`/`bf16`. Because `LocalTranscriptionPipeline` defaults to `unloadPerStage=True`, Pyannote unloads before Cohere loads, so peak memory stays within budget on 16 GB+ Macs (and workable on 8 GB Macs if `torch.mps.empty_cache()` is called in `release()`).
- **Expected speedup:** 2.5x-5x faster ASR vs CPU INT8 ONNX.

### WeSpeaker and MMS aligner on `CoreMLExecutionProvider` (low priority)
- Both `voxceleb_resnet293_LM.onnx` and `mms-300m-aligner.onnx` are standard `fp32` graphs. Passing `providers=["CoreMLExecutionProvider", "CPUExecutionProvider"]` works cleanly, dropping WeSpeaker from ~330ms to ~40ms per turn, though total savings per 60-minute meeting is under 10 seconds unless `wholeFileAsr` is turned on.

## Target 2: Vulkan (Linux and Windows non-CUDA GPUs)

Vulkan is a dead end for our current Python PyTorch + ONNX Runtime stack.

1. **No official Vulkan Execution Provider in `onnxruntime`.** Prebuilt `onnxruntime` / `onnxruntime-gpu` wheels ship CPU, CUDA, TensorRT, CoreML, DirectML (Windows), ROCm, and OpenVINO execution providers. There is no `VulkanExecutionProvider` in upstream Python packages.
2. **PyTorch desktop wheels do not ship a usable Vulkan backend.** PyTorch's Vulkan backend targets mobile/Android, is not compiled into standard Linux/Windows PyPI wheels, and lacks operator coverage for `pyannote` (SincNet + BiLSTM).
3. **Cohere INT8 ONNX is still host-copy-bound in Python.** Even with a GPU execution provider on Linux/Windows, the Python decoder loop in `CohereAsrEngine._transcribe_chunk_int8_sync` copies the ~65 MB KV cache between host and device on every token unless rewritten to use `ort.IOBinding` with an `fp16` ONNX export.

### Alternatives if we want non-NVIDIA acceleration on Linux/Windows later
- **Intel iGPUs / Arc / NPU (Linux & Windows):** `onnxruntime-openvino` (`OpenVINOExecutionProvider`) or PyTorch `xpu`.
- **AMD GPUs (Linux):** PyTorch ROCm + `onnxruntime-rocm` (`ROCMExecutionProvider`).
- **Windows (AMD / Intel / NVIDIA / Qualcomm):** `onnxruntime-directml` (`DmlExecutionProvider`).
- **Actual Vulkan runtime:** Would require replacing Cohere + Pyannote with `ggml`-based equivalents (`whisper.cpp` / `sherpa-onnx` Vulkan), which means giving up Cohere Transcribe and `pyannote-community-1`. Not worth the accuracy drop.

## Implementation checklist (when we pick this up)

1. Add a small device resolver helper (e.g., `ml/device.py`) that checks `OLIVE_ML_DEVICE` (`auto`, `cpu`, `mps`, `cuda`) and defaults `auto` to `mps` on Apple Silicon (`torch.backends.mps.is_available()`), `cuda` if available, else `cpu`.
2. Update `PyannoteSpeakerDiarizer._ensure_pipeline_sync` (`ml/diarize.py`):
   - Move `pipe.to(device)` instead of hardcoded `torch.device("cpu")`.
   - Verify `_fast_get_embeddings` works when `pipe` is on `mps`/`cuda`, and call `torch.mps.empty_cache()` / `torch.cuda.empty_cache()` in `release()`.
3. Implement the PyTorch `CohereAsrForConditionalGeneration` branch in `CohereAsrEngine` (`ml/asr_cohere.py`):
   - When device is `mps` or `cuda` (or `dtype in ("fp16", "bf16")`), load `COHERE_TORCH_UNGATED_REPO` in `torch.bfloat16` / `torch.float16` on the target device instead of the CPU INT8 ONNX sessions.
   - Call `torch.mps.empty_cache()` / `torch.cuda.empty_cache()` in `CohereAsrEngine.release()`.
4. Optionally pass `["CoreMLExecutionProvider", "CPUExecutionProvider"]` on macOS in `WeSpeakerEmbeddingExtractor` (`ml/embed.py`) and `CtcForcedAligner` (`ml/align.py`).
