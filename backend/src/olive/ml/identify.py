"""ASR-first speaker identification for cloud transcripts.

Cloud ASR providers (Speechmatics, AssemblyAI) return word timings with a
speaker label per word/utterance. Those labels define speaker *turns*, so we
can skip diarization entirely: decode the audio locally, slice the longest
turns per cloud speaker cluster, embed them with the local WeSpeaker model,
and match the resulting centroids against enrolled speakers' local
voiceprints (``providerIds["local"]``). This makes local voiceprints the
single speaker-identity store across all providers.

Any failure (missing audio, undecodable file, unavailable embedding model,
zero-vector embeddings) returns ``None`` so callers fall back to the raw
cloud speaker labels.
"""

from __future__ import annotations

import inspect
import json
from collections.abc import Callable
from typing import Any

from ..logging_db import logger
from ..schemas import EnrolledSpeaker, Transcript, TranscriptSegment, TranscriptWord
from .audio import load_audio_samples
from .diarize import PyannoteSpeakerDiarizer
from .embed import WeSpeakerEmbeddingExtractor
from .protocols import DiscoveredSpeakerVoiceprint, SpeakerEmbedder, VoiceprintVector
from .scoring import normalize_vector, score_against_trusted_vectors

MIN_TURN_MS = 300


def turns_from_transcript(transcript: Transcript) -> list[dict[str, Any]]:
    """Derive speaker turns ({startMs, endMs, speakerId}) from transcript segments."""
    turns: list[dict[str, Any]] = []
    for seg in transcript.segments:
        if seg.endMs <= seg.startMs:
            continue
        turns.append({"startMs": int(seg.startMs), "endMs": int(seg.endMs), "speakerId": seg.speaker})
    return turns


def _trusted_vectors(enrolled: EnrolledSpeaker) -> list[VoiceprintVector]:
    vectors: list[VoiceprintVector] = []
    for item in enrolled.providerIds.get("local") or []:
        try:
            parsed = json.loads(item) if isinstance(item, str) else item
        except Exception:
            continue
        if isinstance(parsed, list) and parsed:
            if isinstance(parsed[0], list):
                vectors.extend(normalize_vector(sub) for sub in parsed if isinstance(sub, list) and sub)
            else:
                vectors.append(normalize_vector(parsed))
    return vectors


def match_cluster_centroids(
    cluster_centroids: dict[str, VoiceprintVector],
    enrolled_speakers: list[EnrolledSpeaker],
    similarity_threshold: float = 0.45,
    decision_margin: float = 0.06,
) -> tuple[dict[str, str], list[DiscoveredSpeakerVoiceprint]]:
    """Greedy one-to-one cluster -> enrolled-speaker assignment.

    Mirrors the matching used by the local pipeline: a cluster matches when
    its best cosine score clears ``similarity_threshold`` and beats the
    runner-up by ``decision_margin``. Unmatched clusters keep their cloud
    label and are returned as non-enrolled discoveries carrying their
    centroid voiceprint (so they can be adopted/enrolled later).
    """
    profiles: list[dict[str, Any]] = []
    for spk in enrolled_speakers:
        trusted = _trusted_vectors(spk)
        if trusted:
            profiles.append({"id": spk.id, "name": spk.name, "trustedVectors": trusted})

    candidates: list[dict[str, Any]] = []
    for cid, centroid in cluster_centroids.items():
        if not centroid or not any(abs(v) > 1e-9 for v in centroid):
            continue
        scored = sorted(
            ((p, score_against_trusted_vectors(centroid, p["trustedVectors"])) for p in profiles),
            key=lambda pair: pair[1],
            reverse=True,
        )
        if not scored:
            continue
        top_profile, top_score = scored[0]
        second_score = scored[1][1] if len(scored) > 1 else -1.0
        if top_score >= similarity_threshold and (
            len(scored) == 1 or top_score - second_score >= decision_margin
        ):
            candidates.append({"clusterId": cid, "profile": top_profile, "score": top_score})

    candidates.sort(key=lambda m: m["score"], reverse=True)
    cluster_to_name: dict[str, str] = {}
    discovered: dict[str, DiscoveredSpeakerVoiceprint] = {}
    used_speakers: set[str] = set()
    for match in candidates:
        cid, profile = match["clusterId"], match["profile"]
        if cid in cluster_to_name or profile["id"] in used_speakers:
            continue
        used_speakers.add(profile["id"])
        cluster_to_name[cid] = profile["name"]
        discovered[profile["name"]] = DiscoveredSpeakerVoiceprint(
            speakerId=profile["id"],
            name=profile["name"],
            voiceprint=cluster_centroids[cid],
            isEnrolled=True,
            similarityScore=float(match["score"]),
        )

    for cid, centroid in cluster_centroids.items():
        if cid not in cluster_to_name:
            cluster_to_name[cid] = cid
            discovered[cid] = DiscoveredSpeakerVoiceprint(
                speakerId=cid, name=cid, voiceprint=centroid, isEnrolled=False
            )
    return cluster_to_name, list(discovered.values())


def rename_transcript_speakers(transcript: Transcript, cluster_to_name: dict[str, str]) -> Transcript:
    """Return a copy of ``transcript`` with segment/word speakers renamed."""
    if not any(cluster_to_name.get(seg.speaker, seg.speaker) != seg.speaker for seg in transcript.segments):
        return transcript
    segments: list[TranscriptSegment] = []
    for seg in transcript.segments:
        name = cluster_to_name.get(seg.speaker, seg.speaker)
        words = (
            [
                TranscriptWord(
                    startMs=w.startMs,
                    endMs=w.endMs,
                    word=w.word,
                    confidence=w.confidence,
                    speaker=cluster_to_name.get(w.speaker, name) if w.speaker else name,
                )
                for w in seg.words
            ]
            if seg.words
            else None
        )
        segments.append(
            TranscriptSegment(startMs=seg.startMs, endMs=seg.endMs, speaker=name, text=seg.text, words=words)
        )
    return Transcript(
        segments=segments,
        language=transcript.language,
        durationMs=transcript.durationMs,
        speakers=transcript.speakers,
    )


async def _emit_progress(
    on_progress: Callable[[dict[str, Any]], Any] | None, payload: dict[str, Any]
) -> None:
    if not callable(on_progress):
        return
    res = on_progress(payload)
    if inspect.isawaitable(res):
        await res


async def identify_speakers_from_turns(
    samples: Any,
    sample_rate: int,
    transcript: Transcript,
    enrolled_speakers: list[EnrolledSpeaker],
    embedding_extractor: SpeakerEmbedder | None = None,
    similarity_threshold: float = 0.45,
    decision_margin: float = 0.06,
    meeting_id: str | None = None,
    on_progress: Callable[[dict[str, Any]], Any] | None = None,
) -> tuple[Transcript, list[DiscoveredSpeakerVoiceprint]] | None:
    """Identify cloud speaker clusters against enrolled local voiceprints.

    Returns ``(renamed_transcript, discovered)`` or ``None`` when no usable
    voiceprint could be extracted (caller keeps cloud labels).
    """
    turns = [
        t
        for t in turns_from_transcript(transcript)
        if t["endMs"] - t["startMs"] >= MIN_TURN_MS and str(t["speakerId"]).strip().upper() != "UU"
    ]
    if not turns:
        return None

    clusters = {str(t["speakerId"]) for t in turns}
    await _emit_progress(
        on_progress,
        {
            "phase": "embedding",
            "current": 0,
            "total": len(clusters),
            "message": f"Extracting voiceprints for {len(clusters)} speaker(s) from {len(turns)} turns...",
        },
    )
    extractor = embedding_extractor or WeSpeakerEmbeddingExtractor()
    diarizer = PyannoteSpeakerDiarizer(extractor)
    _segments, centroids = await diarizer.extract_cluster_voiceprints(
        samples, turns, sample_rate, on_progress=on_progress, meeting_id=meeting_id
    )
    await _emit_progress(
        on_progress,
        {
            "phase": "matching",
            "current": len(clusters),
            "total": len(clusters),
            "message": f"Matching {len(clusters)} voiceprint(s) against {len(enrolled_speakers)} enrolled speaker(s)...",
        },
    )
    usable = {cid: vec for cid, vec in centroids.items() if vec and any(abs(v) > 1e-9 for v in vec)}
    if not usable:
        logger.warn(
            "Cloud speaker identification produced no usable voiceprints",
            {"category": "transcription", "meetingId": meeting_id},
        )
        return None

    cluster_to_name, discovered = match_cluster_centroids(
        usable, enrolled_speakers, similarity_threshold, decision_margin
    )
    logger.info(
        "Identified cloud speaker clusters against local voiceprints",
        {
            "category": "transcription",
            "meetingId": meeting_id,
            "clusters": cluster_to_name,
            "matched": [d.name for d in discovered if d.isEnrolled],
        },
    )
    return rename_transcript_speakers(transcript, cluster_to_name), discovered


async def identify_cloud_transcript_speakers(
    audio_path: str,
    transcript: Transcript,
    enrolled_speakers: list[EnrolledSpeaker],
    similarity_threshold: float = 0.45,
    decision_margin: float = 0.06,
    meeting_id: str | None = None,
    on_progress: Callable[[dict[str, Any]], Any] | None = None,
) -> tuple[Transcript, list[DiscoveredSpeakerVoiceprint]] | None:
    """Decode ``audio_path`` and identify speakers; ``None`` on any failure."""
    try:
        await _emit_progress(
            on_progress,
            {"phase": "decoding", "message": "Decoding audio for speaker identification..."},
        )
        decoded = await load_audio_samples(
            {"audioPath": audio_path, "audioBytes": None, "enhance": False}, 16000
        )
        return await identify_speakers_from_turns(
            decoded.samples,
            decoded.sample_rate,
            transcript,
            enrolled_speakers,
            similarity_threshold=similarity_threshold,
            decision_margin=decision_margin,
            on_progress=on_progress,
            meeting_id=meeting_id,
        )
    except Exception as exc:
        logger.warn(
            "Cloud speaker identification unavailable; keeping cloud speaker labels",
            {"category": "transcription", "meetingId": meeting_id, "error": str(exc)},
        )
        return None
