"""Phase 0 AMI evaluation harness for Olive Python ML stack.

Evaluates on real AMI Corpus (edinburghcstr/ami ihm test split) utterances:
1. Speaker embedding models (WeSpeaker ResNet293-LM vs ResNet221-LM) for EER,
   cosine similarity distribution (same-speaker vs diff-speaker), and optimal
   similarityThreshold / clusteringThreshold / decisionMargin defaults.
2. Forced alignment models (MMS-300m ONNX via ctc-forced-aligner vs
   wav2vec2-large-960h-lv60-self Torch CTC) for utterance/word boundary MAE (ms),
   runtime RTF, and speaker-turn word attribution accuracy on concatenated
   multi-speaker AMI conversations.
"""

from __future__ import annotations

import io
import json
import re
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import onnxruntime as ort
import soundfile as sf
import torch
import torchaudio
import torchaudio.compliance.kaldi as kaldi
import torchaudio.functional as taf
from huggingface_hub import hf_hub_download


@dataclass
class AmiUtterance:
    meeting_id: str
    audio_id: str
    speaker_id: str
    text: str
    samples: np.ndarray
    duration_s: float


def fetch_ami_utterances(max_rows: int = 100, min_duration_s: float = 1.5) -> list[AmiUtterance]:
    url = (
        f"https://datasets-server.huggingface.co/rows"
        f"?dataset=edinburghcstr/ami&config=ihm&split=test&offset=0&length={max_rows}"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "olive-eval/0.2"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.load(resp)

    utterances: list[AmiUtterance] = []
    for item in data.get("rows", []):
        row = item["row"]
        text = (row.get("text") or "").strip()
        if len(text.split()) < 3:
            continue
        audio_list = row.get("audio") or []
        if not audio_list:
            continue
        src_url = audio_list[0]["src"]
        with urllib.request.urlopen(src_url, timeout=30) as aresp:
            wav_bytes = aresp.read()
        samples, sr = sf.read(io.BytesIO(wav_bytes), dtype="float32")
        if samples.ndim > 1:
            samples = samples.mean(axis=1)
        dur = len(samples) / float(sr)
        if dur < min_duration_s:
            continue
        utterances.append(
            AmiUtterance(
                meeting_id=row["meeting_id"],
                audio_id=row["audio_id"],
                speaker_id=row["speaker_id"],
                text=text,
                samples=samples,
                duration_s=dur,
            )
        )
        if len(utterances) >= 36:
            break
    return utterances


def compute_fbank(samples: np.ndarray, sample_rate: int = 16000) -> np.ndarray:
    waveform = torch.from_numpy(samples).unsqueeze(0) * 32768.0
    feats = kaldi.fbank(
        waveform,
        num_mel_bins=80,
        frame_length=25.0,
        frame_shift=10.0,
        dither=0.0,
        sample_frequency=float(sample_rate),
        window_type="hamming",
        use_energy=False,
    )
    feats = feats - feats.mean(dim=0, keepdim=True)
    return feats.unsqueeze(0).numpy().astype(np.float32)


def eval_wespeaker_model(repo_id: str, filename: str, utterances: list[AmiUtterance]) -> dict:
    model_path = hf_hub_download(repo_id=repo_id, filename=filename)
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 4
    opts.inter_op_num_threads = 1
    sess = ort.InferenceSession(model_path, opts, providers=["CPUExecutionProvider"])
    input_name = sess.get_inputs()[0].name

    t0 = time.perf_counter()
    embeddings: list[np.ndarray] = []
    for u in utterances:
        feats = compute_fbank(u.samples)
        emb = sess.run(None, {input_name: feats})[0][0]
        norm = np.linalg.norm(emb)
        embeddings.append(emb / (norm if norm > 0 else 1.0))
    elapsed = time.perf_counter() - t0

    pos_scores: list[float] = []
    neg_scores: list[float] = []
    n = len(utterances)
    for i in range(n):
        for j in range(i + 1, n):
            sim = float(np.dot(embeddings[i], embeddings[j]))
            if utterances[i].speaker_id == utterances[j].speaker_id:
                pos_scores.append(sim)
            else:
                neg_scores.append(sim)

    pos_arr = np.array(pos_scores)
    neg_arr = np.array(neg_scores)

    best_thresh = 0.5
    best_eer = 1.0
    best_diff = 1.0
    for thresh in np.linspace(0.1, 0.9, 161):
        frr = float(np.mean(pos_arr < thresh))
        far = float(np.mean(neg_arr >= thresh))
        diff = abs(frr - far)
        if diff < best_diff:
            best_diff = diff
            best_eer = (frr + far) / 2.0
            best_thresh = float(thresh)

    far_1pct_thresh = float(np.quantile(neg_arr, 0.99))
    tar_at_far_1pct = float(np.mean(pos_arr >= far_1pct_thresh))

    return {
        "model": f"{repo_id}/{filename}",
        "utterance_count": n,
        "positive_pairs": len(pos_scores),
        "negative_pairs": len(neg_scores),
        "eer_pct": round(best_eer * 100, 2),
        "eer_threshold": round(best_thresh, 3),
        "far_1pct_threshold": round(far_1pct_thresh, 3),
        "tar_at_far_1pct": round(tar_at_far_1pct * 100, 2),
        "pos_mean": round(float(pos_arr.mean()), 3),
        "pos_std": round(float(pos_arr.std()), 3),
        "neg_mean": round(float(neg_arr.mean()), 3),
        "neg_std": round(float(neg_arr.std()), 3),
        "avg_extract_ms": round((elapsed / n) * 1000, 1),
    }


def _build_conversation(utterances: list[AmiUtterance]) -> tuple[np.ndarray, str, list[tuple[float, float, str, str]]]:
    subset = utterances[:12]
    silence = np.zeros(int(0.25 * 16000), dtype=np.float32)
    pieces: list[np.ndarray] = []
    gt_turns: list[tuple[float, float, str, str]] = []
    cursor = 0.0
    for u in subset:
        start_s = cursor
        end_s = cursor + (len(u.samples) / 16000.0)
        gt_turns.append((start_s, end_s, u.speaker_id, u.text))
        pieces.append(u.samples)
        pieces.append(silence)
        cursor = end_s + 0.25
    full_audio = np.concatenate(pieces)
    full_text = " ".join(u.text for u in subset)
    return full_audio, full_text, gt_turns


def _score_word_stamps(
    word_stamps: list[dict], gt_turns: list[tuple[float, float, str, str]]
) -> tuple[float, float, float]:
    word_idx = 0
    start_errors_ms: list[float] = []
    end_errors_ms: list[float] = []
    correctly_assigned_words = 0
    total_words = len(word_stamps)

    for start_s, end_s, spk, text in gt_turns:
        n_words = len([w for w in re.split(r"\s+", text.strip()) if w])
        turn_words = word_stamps[word_idx : word_idx + n_words]
        word_idx += n_words
        if not turn_words:
            continue
        pred_start = float(turn_words[0]["start"])
        pred_end = float(turn_words[-1]["end"])
        start_errors_ms.append(abs(pred_start - start_s) * 1000.0)
        end_errors_ms.append(abs(pred_end - end_s) * 1000.0)
        for w in turn_words:
            w_mid = 0.5 * (float(w["start"]) + float(w["end"]))
            best_spk = min(
                gt_turns,
                key=lambda t: 0.0 if (t[0] <= w_mid <= t[1]) else min(abs(w_mid - t[0]), abs(w_mid - t[1])),
            )[2]
            if best_spk == spk:
                correctly_assigned_words += 1

    return (
        round(float(np.mean(start_errors_ms)), 1) if start_errors_ms else 0.0,
        round(float(np.mean(end_errors_ms)), 1) if end_errors_ms else 0.0,
        round((correctly_assigned_words / max(1, total_words)) * 100, 2),
    )


def eval_ctc_forced_aligner_mms(utterances: list[AmiUtterance]) -> dict:
    from ctc_forced_aligner import (
        MODEL_URL,
        Tokenizer,
        ensure_onnx_model,
        generate_emissions,
        get_alignments,
        get_spans,
        postprocess_results,
        preprocess_text,
    )

    full_audio, full_text, gt_turns = _build_conversation(utterances)
    model_path = hf_hub_download(
        repo_id="MahmoudAshraf/mms-300m-1130-forced-aligner",
        filename="model.onnx",
    ) if False else str(Path.home() / ".cache" / "olive-eval" / "mms-300m-aligner.onnx")
    t_load0 = time.perf_counter()
    ensure_onnx_model(model_path, MODEL_URL)
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 4
    opts.inter_op_num_threads = 1
    session = ort.InferenceSession(model_path, opts, providers=["CPUExecutionProvider"])
    tokenizer = Tokenizer()
    load_s = time.perf_counter() - t_load0

    t0 = time.perf_counter()
    emissions, stride = generate_emissions(session, full_audio, batch_size=4)
    tokens_starred, text_starred = preprocess_text(full_text, romanize=True, language="eng")
    segments, scores, blank_token = get_alignments(emissions, tokens_starred, tokenizer)
    spans = get_spans(tokens_starred, segments, blank_token)
    word_stamps = postprocess_results(text_starred, spans, stride, scores)
    elapsed_s = time.perf_counter() - t0

    start_mae, end_mae, acc = _score_word_stamps(word_stamps, gt_turns)
    audio_dur_s = len(full_audio) / 16000.0
    return {
        "aligner": "ctc-forced-aligner (MMS-300m ONNX)",
        "audio_duration_s": round(audio_dur_s, 2),
        "load_time_s": round(load_s, 2),
        "align_time_s": round(elapsed_s, 2),
        "rtf": round(elapsed_s / audio_dur_s, 4),
        "total_words": len(word_stamps),
        "turn_start_mae_ms": start_mae,
        "turn_end_mae_ms": end_mae,
        "speaker_word_attribution_acc_pct": acc,
    }


def eval_wav2vec2_aligner(utterances: list[AmiUtterance], bundle_name: str = "WAV2VEC2_ASR_BASE_960H") -> dict:
    full_audio, full_text, gt_turns = _build_conversation(utterances)
    bundle = getattr(torchaudio.pipelines, bundle_name)
    t_load0 = time.perf_counter()
    model = bundle.get_model().eval()
    labels = bundle.get_labels()
    dictionary = {c: i for i, c in enumerate(labels)}
    load_s = time.perf_counter() - t_load0

    t0 = time.perf_counter()
    with torch.inference_mode():
        waveform = torch.from_numpy(full_audio).unsqueeze(0)
        emissions, _ = model(waveform)
        log_probs = torch.log_softmax(emissions, dim=-1)

    words = [re.sub(r"[^A-Z']", "", w.upper()) for w in full_text.split()]
    words = [w for w in words if w]
    targets: list[int] = []
    word_char_Search: list[tuple[int, int, str]] = []
    for w in words:
        s_idx = len(targets)
        for ch in w:
            if ch in dictionary:
                targets.append(dictionary[ch])
        e_idx = len(targets)
        if e_idx > s_idx:
            word_char_Search.append((s_idx, e_idx, w))

    target_tensor = torch.tensor([targets], dtype=torch.int32)
    aligned_tokens, scores = taf.forced_align(log_probs, target_tensor, blank=0)
    token_spans = taf.merge_tokens(aligned_tokens[0], scores[0])

    ratio = (len(full_audio) / 16000.0) / log_probs.shape[1]
    word_stamps: list[dict] = []
    for s_idx, e_idx, w in word_char_Search:
        w_spans = token_spans[s_idx:e_idx]
        if w_spans:
            word_stamps.append(
                {
                    "text": w,
                    "start": w_spans[0].start * ratio,
                    "end": w_spans[-1].end * ratio,
                }
            )
    elapsed_s = time.perf_counter() - t0

    start_mae, end_mae, acc = _score_word_stamps(word_stamps, gt_turns)
    audio_dur_s = len(full_audio) / 16000.0
    return {
        "aligner": f"torchaudio {bundle_name}",
        "audio_duration_s": round(audio_dur_s, 2),
        "load_time_s": round(load_s, 2),
        "align_time_s": round(elapsed_s, 2),
        "rtf": round(elapsed_s / audio_dur_s, 4),
        "total_words": len(word_stamps),
        "turn_start_mae_ms": start_mae,
        "turn_end_mae_ms": end_mae,
        "speaker_word_attribution_acc_pct": acc,
    }


def main() -> None:
    print("Fetching AMI IHM test utterances...")
    utterances = fetch_ami_utterances()
    speakers = sorted({u.speaker_id for u in utterances})
    print(f"Loaded {len(utterances)} AMI utterances across {len(speakers)} speakers: {speakers}")

    emb_results = []
    for repo, fname in [
        ("Wespeaker/wespeaker-voxceleb-resnet293-LM", "voxceleb_resnet293_LM.onnx"),
        ("Wespeaker/wespeaker-voxceleb-resnet221-LM", "voxceleb_resnet221_LM.onnx"),
    ]:
        print(f"Evaluating {repo}...")
        res = eval_wespeaker_model(repo, fname, utterances)
        print(" ", res)
        emb_results.append(res)

    align_results = []
    print("Evaluating ctc-forced-aligner (MMS-300m ONNX)...")
    res_mms = eval_ctc_forced_aligner_mms(utterances)
    print(" ", res_mms)
    align_results.append(res_mms)

    for bname in ["WAV2VEC2_ASR_BASE_960H", "WAV2VEC2_ASR_LARGE_LV60K_960H"]:
        print(f"Evaluating torchaudio {bname}...")
        res_w2v = eval_wav2vec2_aligner(utterances, bname)
        print(" ", res_w2v)
        align_results.append(res_w2v)

    out = {
        "ami_utterances": len(utterances),
        "ami_speakers": speakers,
        "embeddings": emb_results,
        "alignment": align_results,
    }
    out_path = Path(__file__).parent / "results.json"
    out_path.write_text(json.dumps(out, indent=2) + "\n")
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
