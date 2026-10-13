# Phase 0 — AMI Evaluation Results & Locked ML Defaults

Evaluated on real AMI Meeting Corpus (`edinburghcstr/ami`, `ihm` test split, 36 utterances >= 1.5s across 4 speakers: `FEO070`, `FEO072`, `MEE071`, `MEE073`) via `backend/eval/run_ami_eval.py`.

## 1. Speaker Embeddings (Voiceprints)

| Model | EER (%) | EER Threshold | FAR=1% Threshold | TAR @ FAR=1% | Same-Spk Cosine (μ ± σ) | Diff-Spk Cosine (μ ± σ) | Avg Extract (ms) |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **`Wespeaker/wespeaker-voxceleb-resnet293-LM` (`voxceleb_resnet293_LM.onnx`)** | **3.91%** | 0.270 | 0.350 | **87.67%** | 0.584 ± 0.164 | 0.052 ± 0.108 | 334.3 ms |
| `Wespeaker/wespeaker-voxceleb-resnet221-LM` (`voxceleb_resnet221_LM.onnx`) | 5.97% | 0.275 | 0.343 | 86.99% | 0.572 ± 0.178 | 0.068 ± 0.105 | 256.3 ms |

### Locked Voiceprint Decisions
- **Selected model:** `Wespeaker/wespeaker-voxceleb-resnet293-LM` (`voxceleb_resnet293_LM.onnx`, 256-dim r-vector with 80-bin Kaldi fbank + CMN).
- **Default `localSimilarityThreshold`:** `0.45` (safely above the 1% FAR floor of `0.35`, below the positive pair mean of `0.584`, further boosted by multi-clip `scoreAgainstTrustedVectors`).
- **Default `localClusteringThreshold`:** `0.50` (cosine distance / agglomerative threshold for speaker turn clustering).
- **Default `decisionMargin`:** `0.06`.

## 2. Forced Alignment & Speaker-Turn Word Attribution

Evaluated on a 41.36s, 115-word concatenated multi-speaker AMI conversation with known ground-truth turn boundaries and speaker IDs:

| Aligner | RTF (CPU) | Turn Start MAE (ms) | Turn End MAE (ms) | Speaker Word Attribution Accuracy |
| :--- | ---: | ---: | ---: | ---: |
| **`torchaudio WAV2VEC2_ASR_LARGE_LV60K_960H`** | **0.0974** | **139.3 ms** | **451.2 ms** | **100.0%** |
| **`ctc-forced-aligner` (`MahmoudAshraf/mms-300m-1130-forced-aligner` ONNX)** | 0.2269 | 195.0 ms | 526.7 ms | **100.0%** |
| `torchaudio WAV2VEC2_ASR_BASE_960H` | 0.0351 | 215.4 ms | 465.5 ms | 99.13% |

### Locked Aligner Decision
- Both `WAV2VEC2_ASR_LARGE_LV60K_960H` and `ctc-forced-aligner` (MMS-300m ONNX) achieve **100.0% speaker word attribution accuracy** on AMI.
- Use `ctc-forced-aligner` (MMS-300m ONNX) as the primary multilingual forced aligner (1.01s cold load, < 500 MB RAM, 1,130 languages) with `torchaudio` CTC alignment available via the `Aligner` protocol.

## 3. Cohere Transcribe 03-2026 INT8 vs FP32

- **INT8 ONNX (`vigneshlabs/cohere-transcribe-03-2026-int8-onnx` / `onnx-community/cohere-transcribe-03-2026-ONNX`):**
  - Disk & memory footprint: **2.69 GB** (never materialises FP32 in memory; fits comfortably inside the 8 GB host limit when loaded stage-by-stage).
  - AMI IHM WER: **15.38%** (vs **16.24%** FP32; Δ `-0.85%`), 1.5x faster on CPU (`~0.08 RTF`, or ~5 min for a 60-min meeting).
- **PyTorch (`CohereLabs/cohere-transcribe-03-2026` / `evewashere/cohere-transcribe-03-2026-ungated`):**
  - Supported via `CohereAsrForConditionalGeneration` in `transformers>=5.4` when `precision="fp32"` or `"bf16"` is requested.
