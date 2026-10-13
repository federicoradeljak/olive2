"""Numpy-based speaker embedding vector math and scoring (port of embedding.ts)."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import numpy as np

from .protocols import VoiceprintVector


def l2_norm(vec: Sequence[float] | np.ndarray) -> float:
    arr = np.asarray(vec, dtype=np.float64)
    if arr.size == 0:
        return 0.0
    return float(np.linalg.norm(arr))


l2Norm = l2_norm


def normalize_vector(vec: Sequence[float] | np.ndarray) -> VoiceprintVector:
    arr = np.asarray(vec, dtype=np.float64)
    if arr.size == 0:
        return []
    norm = float(np.linalg.norm(arr))
    if norm == 0.0 or not np.isfinite(norm):
        return [0.0] * int(arr.size)
    return (arr / norm).astype(np.float64).tolist()


normalizeVector = normalize_vector


def cosine_similarity(
    a: Sequence[float] | np.ndarray | None,
    b: Sequence[float] | np.ndarray | None,
) -> float:
    if a is None or b is None:
        return 0.0
    arr_a = np.asarray(a, dtype=np.float64)
    arr_b = np.asarray(b, dtype=np.float64)
    if arr_a.size == 0 or arr_b.size == 0:
        return 0.0
    length = min(int(arr_a.size), int(arr_b.size))
    va = arr_a[:length]
    vb = arr_b[:length]
    denom = float(np.linalg.norm(va) * np.linalg.norm(vb))
    if denom == 0.0 or not np.isfinite(denom):
        return 0.0
    sim = float(np.dot(va, vb) / denom)
    return max(-1.0, min(1.0, sim))


cosineSimilarity = cosine_similarity


def score_against_trusted_vectors(
    query: Sequence[float] | np.ndarray | None,
    trusted_vectors: Sequence[Sequence[float] | np.ndarray] | None,
) -> float:
    if query is None or not trusted_vectors:
        return 0.0
    max_sim = -1.0
    for vec in trusted_vectors:
        sim = cosine_similarity(query, vec)
        if sim > max_sim:
            max_sim = sim
    return max(-1.0, max_sim)


scoreAgainstTrustedVectors = score_against_trusted_vectors


def update_voiceprint_centroid(
    existing_centroid: Sequence[float] | np.ndarray | None,
    new_sample: Sequence[float] | np.ndarray | None,
    alpha: float = 0.85,
) -> VoiceprintVector:
    if existing_centroid is None or len(existing_centroid) == 0:
        return normalize_vector(new_sample or [])
    if new_sample is None or len(new_sample) == 0:
        return list(existing_centroid)
    a = np.asarray(existing_centroid, dtype=np.float64)
    b = np.asarray(new_sample, dtype=np.float64)
    length = min(int(a.size), int(b.size))
    updated = alpha * a[:length] + (1.0 - alpha) * b[:length]
    return normalize_vector(updated)


updateVoiceprintCentroid = update_voiceprint_centroid


def merge_voiceprint_vectors(
    vectors: Sequence[Sequence[float] | np.ndarray],
) -> VoiceprintVector:
    if not vectors:
        return []
    if len(vectors) == 1:
        return normalize_vector(vectors[0])
    dim = len(vectors[0])
    acc = np.zeros(dim, dtype=np.float64)
    for v in vectors:
        arr = np.asarray(v, dtype=np.float64)
        length = min(dim, int(arr.size))
        acc[:length] += arr[:length]
    return normalize_vector(acc)


mergeVoiceprintVectors = merge_voiceprint_vectors


def merge_weighted_voiceprint_vectors(
    entries: Sequence[dict[str, Any]],
) -> VoiceprintVector:
    valid = [
        e
        for e in entries
        if e.get("vector") is not None
        and len(e["vector"]) > 0
        and float(e.get("weight", 0)) > 0
    ]
    if not valid:
        return []
    if len(valid) == 1:
        return normalize_vector(valid[0]["vector"])
    dim = len(valid[0]["vector"])
    acc = np.zeros(dim, dtype=np.float64)
    for entry in valid:
        vec = np.asarray(entry["vector"], dtype=np.float64)
        w = float(entry["weight"])
        length = min(dim, int(vec.size))
        acc[:length] += vec[:length] * w
    return normalize_vector(acc)


mergeWeightedVoiceprintVectors = merge_weighted_voiceprint_vectors
