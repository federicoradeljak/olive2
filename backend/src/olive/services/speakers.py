"""Speaker registry, voiceprint enrollment, segment editing, and profile rebuild service."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import time
import uuid
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any, Literal

import numpy as np
from sqlalchemy import text
from sqlalchemy.engine import Engine

from ..db import DbHandle, get_db
from ..layout import meeting_paths
from ..logging_db import Logger
from ..logging_db import logger as default_logger
from ..ml import (
    WESPEAKER_MODEL_TAG,
    SpeakerEmbedder,
    VoiceprintVector,
    WeSpeakerEmbeddingExtractor,
    encode_wav,
    load_audio_samples,
    score_against_trusted_vectors,
)
from ..providers.speechmatics import SpeechmaticsClient, transcript_to_text
from ..schemas import (
    Speaker,
    Transcript,
    TranscriptSegment,
    TranscriptWord,
    coalesce_speaker_segments,
)
from ..workflows import QUEUE_SPEECHMATICS, enqueue_stage_job, ensure_dbos_launched_async

MAX_ENROLLMENT_CLIPS = 8
MIN_CONFIRM_DURATION_SEC = 3.0
MAX_CONFIRM_DURATION_SEC = 15.0
MAX_ENROLL_DURATION_SEC = 30.0
OUTLIER_MIN_SIMILARITY = 0.55
REDUNDANT_MAX_SIMILARITY = 0.95

VoiceprintEnrollmentStatus = Literal[
    "enrolled",
    "enrolled_evicted",
    "redundant_skipped",
    "outlier_rejected",
    "duration_skipped",
    "not_available",
]


def _parse_json_field(value: str | None, fallback: Any) -> Any:
    if not value:
        return fallback
    try:
        return json.loads(value)
    except Exception:
        return fallback


def _to_speaker_dict(row: Mapping[Any, Any]) -> dict[str, Any]:
    return Speaker(
        id=row["id"],
        name=row["name"],
        providerIds=_parse_json_field(row.get("provider_ids"), {}),
        enrolledAt=int(row["enrolled_at"]) if row.get("enrolled_at") is not None else None,
        enrollmentClipPaths=_parse_json_field(row.get("enrollment_clip_paths"), []),
        createdAt=int(row["created_at"]),
    ).model_dump()


def _extract_transcript_segments(parsed_data: Any) -> dict[str, Any]:
    if isinstance(parsed_data, dict) and isinstance(parsed_data.get("segments"), list):
        segs = [
            TranscriptSegment.model_validate(s) if not isinstance(s, TranscriptSegment) else s
            for s in parsed_data["segments"]
        ]
        return {
            "segments": segs,
            "isArrayFormat": False,
            "language": parsed_data.get("language"),
            "durationMs": parsed_data.get("durationMs"),
            "speakers": parsed_data.get("speakers"),
        }

    if isinstance(parsed_data, list):
        segs = []
        for item in parsed_data:
            if not isinstance(item, dict):
                continue
            txt = (item.get("text") or item.get("content") or "").strip()
            if not txt:
                continue
            raw_words = item.get("words")
            words = (
                [TranscriptWord.model_validate(w) for w in raw_words if isinstance(w, dict)]
                if isinstance(raw_words, list)
                else None
            )
            segs.append(
                TranscriptSegment(
                    speaker=str(item.get("speaker") or "Speaker"),
                    text=str(item.get("text") or item.get("content") or ""),
                    startMs=int(item.get("startMs") or item.get("start_time") or 0),
                    endMs=int(item.get("endMs") or item.get("end_time") or 0),
                    verified=bool(item.get("verified")),
                    words=words,
                )
            )
        return {
            "segments": segs,
            "isArrayFormat": True,
            "language": None,
            "durationMs": None,
            "speakers": None,
        }

    return {
        "segments": [],
        "isArrayFormat": False,
        "language": None,
        "durationMs": None,
        "speakers": None,
    }


def _atomic_write_text(target_path: Path, content: str) -> None:
    target_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = target_path.with_name(f"{target_path.name}.tmp")
    tmp_path.write_text(content, encoding="utf-8")
    tmp_path.replace(target_path)


def _is_placeholder_name(name: str) -> bool:
    s = name.strip()
    return bool(re.match(r"^speaker\s*\d+$", s, re.I) or re.match(r"^s\d+$", s, re.I))


class SpeakerService:
    def __init__(
        self,
        options: dict[str, Any] | None = None,
        *,
        db: Engine | DbHandle | None = None,
        config_dir: str | None = None,
        meetings_dir: str | None = None,
        speechmatics_client: SpeechmaticsClient | None = None,
        embedding_extractor: SpeakerEmbedder | None = None,
        logger: Logger | None = None,
        now: Callable[[], int] | None = None,
    ) -> None:
        opts = options or {}
        raw_db = db or opts.get("db")
        if isinstance(raw_db, DbHandle):
            self.db: Engine = raw_db.engine
        elif isinstance(raw_db, Engine):
            self.db = raw_db
        else:
            self.db = get_db()

        self.config_dir = str(config_dir or opts.get("configDir") or opts.get("config_dir") or "")
        self.meetings_dir: str | None = (
            str(meetings_dir or opts.get("meetingsDir") or opts.get("meetings_dir"))
            if (meetings_dir or opts.get("meetingsDir") or opts.get("meetings_dir"))
            else None
        )
        self.client: SpeechmaticsClient = (
            speechmatics_client
            or opts.get("speechmaticsClient")
            or opts.get("speechmatics_client")
            or SpeechmaticsClient()
        )
        self.local_embedding_extractor: SpeakerEmbedder = (
            embedding_extractor
            or opts.get("embeddingExtractor")
            or opts.get("embedding_extractor")
            or WeSpeakerEmbeddingExtractor()
        )
        self.logger: Logger = logger or opts.get("logger") or default_logger
        self.now: Callable[[], int] = now or opts.get("now") or (lambda: int(time.time() * 1000))

    async def ensure_embedding_model_current(self) -> bool:
        """Checks `local_embedding_model` in `sync_state` and triggers a rebuild if changed."""
        with self.db.connect() as conn:
            row = (
                conn.execute(text("SELECT value FROM sync_state WHERE key = 'local_embedding_model'"))
                .mappings()
                .first()
            )

        if row and row.get("value") == WESPEAKER_MODEL_TAG:
            return False

        await self.rebuild_speaker_profiles({"force": True})
        with self.db.begin() as conn:
            conn.execute(
                text(
                    """
                    INSERT INTO sync_state (key, value)
                    VALUES ('local_embedding_model', :val)
                    ON CONFLICT(key) DO UPDATE SET value = :val
                    """
                ),
                {"val": WESPEAKER_MODEL_TAG},
            )
        return True

    async def _adopt_voiceprint_sample(
        self,
        *,
        speaker_row: Mapping[Any, Any],
        samples: np.ndarray,
        sample_rate: int = 16000,
        clip_filename: str,
        is_anchor: bool = False,
        meeting_id: str | None = None,
        segment_index: int | None = None,
    ) -> dict[str, Any]:
        current_time = self.now()
        duration_sec = len(samples) / float(sample_rate)

        min_sec = MIN_CONFIRM_DURATION_SEC
        max_sec = MAX_ENROLL_DURATION_SEC if is_anchor else MAX_CONFIRM_DURATION_SEC
        if duration_sec < min_sec or duration_sec > max_sec:
            return {
                "status": "duration_skipped",
                "voiceprintEnrolled": False,
                "statusReason": f"Duration ({duration_sec:.1f}s) outside optimal window [{min_sec:.1f}s - {max_sec:.1f}s]",
                "updatedSpeakerRow": speaker_row,
            }

        try:
            new_embedding = await self.local_embedding_extractor.extract(samples, sample_rate)
        except Exception as exc:
            self.logger.warn(
                "Could not extract local voiceprint embedding",
                {
                    "speakerId": speaker_row["id"],
                    "meetingId": meeting_id,
                    "segmentIndex": segment_index,
                    "error": str(exc),
                },
            )
            return {
                "status": "not_available",
                "voiceprintEnrolled": False,
                "statusReason": "Local embedding extraction failed",
                "updatedSpeakerRow": speaker_row,
            }

        provider_ids = _parse_json_field(speaker_row.get("provider_ids"), {})
        clips: list[str] = list(_parse_json_field(speaker_row.get("enrollment_clip_paths"), []))
        local_vec_strs: list[str] = list(provider_ids.get("local") or [])

        existing_vectors: list[VoiceprintVector] = []
        for s in local_vec_strs:
            try:
                v = json.loads(s) if isinstance(s, str) else s
                if isinstance(v, list) and len(v) > 0:
                    existing_vectors.append(v)
            except Exception:
                pass

        similarity: float | None = None
        if not is_anchor and existing_vectors:
            similarity = score_against_trusted_vectors(new_embedding, existing_vectors)
            if similarity < OUTLIER_MIN_SIMILARITY:
                return {
                    "status": "outlier_rejected",
                    "voiceprintEnrolled": False,
                    "similarity": similarity,
                    "statusReason": f"Similarity ({similarity:.3f}) is below outlier threshold ({OUTLIER_MIN_SIMILARITY})",
                    "updatedSpeakerRow": speaker_row,
                }
            if similarity > REDUNDANT_MAX_SIMILARITY:
                return {
                    "status": "redundant_skipped",
                    "voiceprintEnrolled": False,
                    "similarity": similarity,
                    "statusReason": f"Similarity ({similarity:.3f}) exceeds redundancy threshold ({REDUNDANT_MAX_SIMILARITY})",
                    "updatedSpeakerRow": speaker_row,
                }

        speaker_folder = Path(self.config_dir) / "speakers" / speaker_row["id"]
        speaker_folder.mkdir(parents=True, exist_ok=True)
        clip_rel_path = f"speakers/{speaker_row['id']}/{clip_filename}"
        clip_wav_bytes = encode_wav(samples, sample_rate)
        (Path(self.config_dir) / clip_rel_path).write_bytes(clip_wav_bytes)

        status: VoiceprintEnrollmentStatus = "enrolled"
        if len(clips) >= MAX_ENROLLMENT_CLIPS and len(clips) > 1:
            evicted_rel = clips.pop(1)
            if len(local_vec_strs) > 1:
                local_vec_strs.pop(1)
            try:
                (Path(self.config_dir) / evicted_rel).unlink(missing_ok=True)
            except Exception as exc:
                self.logger.warn(
                    "Could not remove evicted confirmation clip",
                    {"path": evicted_rel, "error": str(exc)},
                )
            status = "enrolled_evicted"

        if clip_rel_path not in clips:
            clips.append(clip_rel_path)
        local_vec_strs.append(json.dumps(new_embedding))
        provider_ids["local"] = local_vec_strs

        enrolled_at = speaker_row.get("enrolled_at") or current_time
        with self.db.begin() as conn:
            conn.execute(
                text(
                    """
                    UPDATE speakers
                    SET provider_ids = :pids, enrollment_clip_paths = :clips, enrolled_at = :eat
                    WHERE id = :id
                    """
                ),
                {
                    "pids": json.dumps(provider_ids),
                    "clips": json.dumps(clips),
                    "eat": enrolled_at,
                    "id": speaker_row["id"],
                },
            )
            updated_row = (
                conn.execute(
                    text("SELECT * FROM speakers WHERE id = :id"),
                    {"id": speaker_row["id"]},
                )
                .mappings()
                .one()
            )

        if self.client and self.client.is_configured and not provider_ids.get("speechmatics"):

            async def _enqueue_sm_enroll() -> None:
                try:
                    await ensure_dbos_launched_async(config_dir=self.config_dir)
                    await enqueue_stage_job(
                        QUEUE_SPEECHMATICS,
                        lambda: self._enroll_speechmatics_clip_background(
                            speaker_row["id"], clip_wav_bytes, clip_filename
                        ),
                        deduplication_id=f"sm-enroll:{speaker_row['id']}:{clip_filename}",
                    )
                except Exception:
                    await self._enroll_speechmatics_clip_background(
                        speaker_row["id"], clip_wav_bytes, clip_filename
                    )

            asyncio.create_task(_enqueue_sm_enroll())

        return {
            "status": status,
            "voiceprintEnrolled": True,
            "similarity": similarity,
            "statusReason": (
                "Enrolled new sample, evicted oldest non-anchor clip (cap reached)"
                if status == "enrolled_evicted"
                else "Enrolled new voiceprint sample"
            ),
            "updatedSpeakerRow": updated_row,
        }

    async def _enroll_speechmatics_clip_background(
        self,
        speaker_id: str,
        clip_wav_bytes: bytes,
        clip_filename: str,
    ) -> None:
        if not self.client or not self.client.is_configured:
            return
        try:
            job = await self.client.submit_job(
                {
                    "audio": clip_wav_bytes,
                    "filename": clip_filename,
                    "mime": "audio/wav",
                    "language": "en",
                    "getSpeakers": True,
                }
            )
            start_wait = self.now()
            while self.now() - start_wait < 60_000:
                st = await self.client.get_job(job["id"])
                if st.get("status") == "done":
                    sm_json = await self.client.get_transcript(job["id"], "json-v2")
                    extracted_ids: list[str] = []
                    for s in sm_json.get("speakers") or []:
                        if isinstance(s, dict):
                            for sid in list(s.get("speaker_identifiers") or []):
                                if sid and sid not in extracted_ids:
                                    extracted_ids.append(sid)
                    if extracted_ids:
                        with self.db.begin() as conn:
                            s_row = (
                                conn.execute(
                                    text("SELECT * FROM speakers WHERE id = :id"),
                                    {"id": speaker_id},
                                )
                                .mappings()
                                .first()
                            )
                            if s_row:
                                pids = _parse_json_field(s_row.get("provider_ids"), {})
                                cur_sm = list(
                                    dict.fromkeys([*(pids.get("speechmatics") or []), *extracted_ids])
                                )
                                pids["speechmatics"] = cur_sm
                                conn.execute(
                                    text("UPDATE speakers SET provider_ids = :pids WHERE id = :id"),
                                    {"pids": json.dumps(pids), "id": speaker_id},
                                )
                    try:
                        await self.client.delete_job(job["id"])
                    except Exception:
                        pass
                    break
                if st.get("status") in ("rejected", "deleted"):
                    break
                await asyncio.sleep(1.5)
        except Exception as exc:
            self.logger.warn(
                "Could not enroll audio slice with Speechmatics in background",
                {"speakerId": speaker_id, "error": str(exc)},
            )

    async def list_speakers(self) -> list[dict[str, Any]]:
        with self.db.connect() as conn:
            rows = conn.execute(text("SELECT * FROM speakers ORDER BY name ASC")).mappings().all()
            counts = (
                conn.execute(
                    text(
                        "SELECT speaker_id, COUNT(meeting_id) AS cnt "
                        "FROM meeting_speakers GROUP BY speaker_id"
                    )
                )
                .mappings()
                .all()
            )
        count_map = {c["speaker_id"]: int(c["cnt"]) for c in counts}
        return [
            {
                **_to_speaker_dict(r),
                "meetingCount": count_map.get(r["id"], 0),
            }
            for r in rows
        ]

    listSpeakers = list_speakers

    async def get_speaker(self, speaker_id: str) -> dict[str, Any] | None:
        with self.db.connect() as conn:
            row = (
                conn.execute(
                    text("SELECT * FROM speakers WHERE id = :id"),
                    {"id": speaker_id},
                )
                .mappings()
                .first()
            )
            if not row:
                return None

            meeting_links = (
                conn.execute(
                    text(
                        """
                    SELECT meetings.id, meetings.title, meetings.start_time
                    FROM meeting_speakers
                    INNER JOIN meetings ON meetings.id = meeting_speakers.meeting_id
                    WHERE meeting_speakers.speaker_id = :sid
                    ORDER BY meetings.start_time DESC
                    """
                    ),
                    {"sid": speaker_id},
                )
                .mappings()
                .all()
            )

        return {
            "speaker": _to_speaker_dict(row),
            "meetings": [
                {
                    "id": m["id"],
                    "title": m["title"],
                    "startTime": int(m["start_time"]),
                }
                for m in meeting_links
            ],
        }

    getSpeaker = get_speaker

    async def backfill_voiceprints(self, options: dict[str, Any] | None = None) -> dict[str, Any]:
        opts = options or {}
        current_time = self.now()
        speaker_id = opts.get("speakerId") or opts.get("speaker_id")
        force = bool(opts.get("force"))

        with self.db.connect() as conn:
            if speaker_id:
                rows = (
                    conn.execute(
                        text("SELECT * FROM speakers WHERE id = :id"),
                        {"id": speaker_id},
                    )
                    .mappings()
                    .all()
                )
            else:
                rows = conn.execute(text("SELECT * FROM speakers")).mappings().all()

        updated_speakers: list[dict[str, Any]] = []
        updated_count = 0

        for row in rows:
            pids = _parse_json_field(row.get("provider_ids"), {})
            clips: list[str] = list(_parse_json_field(row.get("enrollment_clip_paths"), []))
            changed = False

            if clips and (not pids.get("local") or force):
                clip_vectors: list[VoiceprintVector] = []
                for rel_path in clips:
                    full_path = Path(self.config_dir) / rel_path
                    if full_path.exists():
                        try:
                            file_bytes = full_path.read_bytes()
                            if len(file_bytes) >= 12:
                                decoded = await load_audio_samples(
                                    {
                                        "audioBytes": file_bytes,
                                        "audioPath": str(full_path),
                                        "enhance": False,
                                    },
                                    16000,
                                )
                                if len(decoded.samples) / 16000.0 >= 2.0:
                                    emb = await self.local_embedding_extractor.extract(decoded.samples, 16000)
                                    clip_vectors.append(emb)
                        except Exception as exc:
                            self.logger.warn(
                                "Failed to extract local voiceprint from stored clip during backfill",
                                {"path": str(full_path), "error": str(exc)},
                            )
                if clip_vectors:
                    pids["local"] = [json.dumps(v) for v in clip_vectors]
                    changed = True

            if (
                clips
                and (not pids.get("speechmatics") or force)
                and (os.environ.get("SPEECHMATICS_API_KEY") or getattr(self.client, "jobs", None) is not None)
            ):
                extracted_sm_ids: list[str] = []
                for rel_path in clips:
                    full_path = Path(self.config_dir) / rel_path
                    if full_path.exists():
                        try:
                            file_bytes = full_path.read_bytes()
                            sub = await self.client.submit_job(
                                {
                                    "audio": file_bytes,
                                    "filename": full_path.name,
                                    "mime": "audio/wav",
                                    "language": "en",
                                    "getSpeakers": True,
                                }
                            )
                            st_start = self.now()
                            while self.now() - st_start < 120_000:
                                st = await self.client.get_job(sub["id"])
                                if st.get("status") == "done":
                                    jv2 = await self.client.get_transcript(sub["id"], "json-v2")
                                    for s in jv2.get("speakers") or []:
                                        if isinstance(s, dict):
                                            for sid in list(s.get("speaker_identifiers") or []):
                                                if sid and sid not in extracted_sm_ids:
                                                    extracted_sm_ids.append(sid)
                                    try:
                                        await self.client.delete_job(sub["id"])
                                    except Exception:
                                        pass
                                    break
                                if st.get("status") in ("rejected", "deleted"):
                                    break
                                await asyncio.sleep(2.0)
                        except Exception as exc:
                            self.logger.warn(
                                "Failed to cross-fill Speechmatics voiceprint from clip",
                                {"path": str(full_path), "error": str(exc)},
                            )
                if extracted_sm_ids:
                    pids["speechmatics"] = extracted_sm_ids
                    changed = True

            with self.db.begin() as conn:
                if changed:
                    conn.execute(
                        text("UPDATE speakers SET provider_ids = :pids, enrolled_at = :eat WHERE id = :id"),
                        {
                            "pids": json.dumps(pids),
                            "eat": row.get("enrolled_at") or current_time,
                            "id": row["id"],
                        },
                    )
                    updated_count += 1
                upd_row = (
                    conn.execute(
                        text("SELECT * FROM speakers WHERE id = :id"),
                        {"id": row["id"]},
                    )
                    .mappings()
                    .one()
                )
                updated_speakers.append(_to_speaker_dict(upd_row))

        return {
            "processed": len(rows),
            "updated": updated_count,
            "speakers": updated_speakers,
        }

    backfillVoiceprints = backfill_voiceprints

    async def rebuild_speaker_profiles(self, options: dict[str, Any] | None = None) -> dict[str, Any]:
        opts = options or {}
        current_time = self.now()
        speaker_id = opts.get("speakerId") or opts.get("speaker_id")

        with self.db.connect() as conn:
            if speaker_id:
                rows = (
                    conn.execute(
                        text("SELECT * FROM speakers WHERE id = :id"),
                        {"id": speaker_id},
                    )
                    .mappings()
                    .all()
                )
            else:
                rows = conn.execute(text("SELECT * FROM speakers")).mappings().all()

        clips_by_hash: dict[str, list[dict[str, Any]]] = {}
        all_clips_by_speaker: dict[str, list[dict[str, Any]]] = {}

        for row in rows:
            clips: list[str] = list(_parse_json_field(row.get("enrollment_clip_paths"), []))
            speaker_clips: list[dict[str, Any]] = []
            for rel_path in clips:
                full_path = Path(self.config_dir) / rel_path
                if full_path.exists():
                    try:
                        file_bytes = full_path.read_bytes()
                        if len(file_bytes) >= 12:
                            sha = hashlib.sha256(file_bytes).hexdigest()
                            decoded = await load_audio_samples(
                                {
                                    "audioBytes": file_bytes,
                                    "audioPath": str(full_path),
                                    "enhance": False,
                                },
                                16000,
                            )
                            dur_sec = len(decoded.samples) / 16000.0
                            info = {
                                "speakerId": row["id"],
                                "relPath": rel_path,
                                "fullPath": str(full_path),
                                "sha256": sha,
                                "durationSec": dur_sec,
                                "samples": decoded.samples,
                            }
                            speaker_clips.append(info)
                            clips_by_hash.setdefault(sha, []).append(info)
                    except Exception:
                        pass
            all_clips_by_speaker[row["id"]] = speaker_clips

        cleaned_clips_count = 0
        retained_clips_count = 0
        updated_speakers_count = 0
        updated_speakers: list[dict[str, Any]] = []

        for row in rows:
            speaker_clips = all_clips_by_speaker.get(row["id"], [])
            clean_clips: list[dict[str, Any]] = []
            seen_hashes: set[str] = set()

            for clip in speaker_clips:
                sharing_speakers = {c["speakerId"] for c in clips_by_hash.get(clip["sha256"], [])}
                is_cross_contaminated = len(sharing_speakers) > 1
                is_duplicate = clip["sha256"] in seen_hashes
                is_duration_invalid = clip["durationSec"] < 2.5 or clip["durationSec"] > 35.0

                if is_cross_contaminated or is_duplicate or is_duration_invalid:
                    cleaned_clips_count += 1
                    try:
                        Path(clip["fullPath"]).unlink(missing_ok=True)
                    except Exception:
                        pass
                else:
                    seen_hashes.add(clip["sha256"])
                    clean_clips.append(clip)
                    retained_clips_count += 1

            if len(clean_clips) > MAX_ENROLLMENT_CLIPS:
                anchor = clean_clips[0]
                other_clips = clean_clips[1:]
                keep_count = MAX_ENROLLMENT_CLIPS - 1
                kept_others = other_clips[-keep_count:]
                evicted_others = other_clips[:-keep_count]
                for evicted in evicted_others:
                    cleaned_clips_count += 1
                    retained_clips_count -= 1
                    try:
                        Path(evicted["fullPath"]).unlink(missing_ok=True)
                    except Exception:
                        pass
                clean_clips = [anchor, *kept_others]

            trusted_vectors: list[VoiceprintVector] = []
            for clip in clean_clips:
                try:
                    emb = await self.local_embedding_extractor.extract(clip["samples"], 16000)
                    trusted_vectors.append(emb)
                except Exception as exc:
                    self.logger.warn(
                        "Failed to extract neural embedding during rebuild",
                        {"path": clip["fullPath"], "error": str(exc)},
                    )

            pids = _parse_json_field(row.get("provider_ids"), {})
            pids["local"] = [json.dumps(v) for v in trusted_vectors]
            clean_paths = [c["relPath"] for c in clean_clips]
            eat = (row.get("enrolled_at") or current_time) if clean_paths else None

            with self.db.begin() as conn:
                conn.execute(
                    text(
                        """
                        UPDATE speakers
                        SET provider_ids = :pids, enrollment_clip_paths = :clips, enrolled_at = :eat
                        WHERE id = :id
                        """
                    ),
                    {
                        "pids": json.dumps(pids),
                        "clips": json.dumps(clean_paths),
                        "eat": eat,
                        "id": row["id"],
                    },
                )
                upd_row = (
                    conn.execute(
                        text("SELECT * FROM speakers WHERE id = :id"),
                        {"id": row["id"]},
                    )
                    .mappings()
                    .one()
                )

            updated_speakers_count += 1
            updated_speakers.append(_to_speaker_dict(upd_row))

        return {
            "processedSpeakers": len(rows),
            "updatedSpeakers": updated_speakers_count,
            "cleanedClipsCount": cleaned_clips_count,
            "retainedClipsCount": retained_clips_count,
            "speakers": updated_speakers,
        }

    rebuildSpeakerProfiles = rebuild_speaker_profiles

    def _load_meeting_transcript_artifact(
        self, meeting_id: str, action_desc: str
    ) -> tuple[Mapping[Any, Any], Mapping[Any, Any], Path, Path, Any]:
        with self.db.connect() as conn:
            meeting = (
                conn.execute(
                    text("SELECT * FROM meetings WHERE id = :id"),
                    {"id": meeting_id},
                )
                .mappings()
                .first()
            )
            if not meeting:
                raise ValueError(f"Meeting not found: {meeting_id}")
            if not self.meetings_dir:
                raise ValueError(f"meetingsDir is required to {action_desc}")

            transcript_art: Mapping[Any, Any] | None = None
            if meeting.get("primary_transcript_artifact_id"):
                transcript_art = (
                    conn.execute(
                        text("SELECT * FROM artifacts WHERE id = :id"),
                        {"id": meeting["primary_transcript_artifact_id"]},
                    )
                    .mappings()
                    .first()
                )

            if (
                not transcript_art
                or transcript_art["kind"] != "transcript"
                or transcript_art["format"] != "json"
            ):
                transcript_art = (
                    conn.execute(
                        text(
                            """
                        SELECT * FROM artifacts
                        WHERE meeting_id = :mid AND kind = 'transcript' AND format = 'json'
                        ORDER BY created_at DESC LIMIT 1
                        """
                        ),
                        {"mid": meeting_id},
                    )
                    .mappings()
                    .first()
                )

            if not transcript_art:
                raise ValueError(f"No JSON transcript artifact found for meeting {meeting_id}")

        folder = Path(
            meeting_paths(
                self.meetings_dir, int(meeting["start_time"]), meeting["title"], meeting["id"]
            ).folder
        )
        json_path = folder / transcript_art["path"]
        parsed_data = json.loads(json_path.read_text(encoding="utf-8"))
        return meeting, transcript_art, folder, json_path, parsed_data

    def _resolve_or_create_speaker(
        self,
        *,
        speaker_id: str | None = None,
        speaker_name: str | None = None,
        current_time: int,
    ) -> Mapping[Any, Any]:
        with self.db.begin() as conn:
            if speaker_id:
                row = (
                    conn.execute(
                        text("SELECT * FROM speakers WHERE id = :id"),
                        {"id": speaker_id},
                    )
                    .mappings()
                    .first()
                )
                if not row:
                    raise ValueError(f"Target speaker not found: {speaker_id}")
                return row

            if speaker_name and speaker_name.strip():
                trimmed = speaker_name.strip()
                all_rows = conn.execute(text("SELECT * FROM speakers")).mappings().all()
                existing = next(
                    (s for s in all_rows if s["name"].strip().lower() == trimmed.lower()),
                    None,
                )
                if existing:
                    return existing

                new_id = str(uuid.uuid4())
                conn.execute(
                    text(
                        """
                        INSERT INTO speakers (
                          id, name, provider_ids, enrolled_at, enrollment_clip_paths, created_at
                        ) VALUES (:id, :name, '{}', NULL, '[]', :now)
                        """
                    ),
                    {"id": new_id, "name": trimmed, "now": current_time},
                )
                return (
                    conn.execute(
                        text("SELECT * FROM speakers WHERE id = :id"),
                        {"id": new_id},
                    )
                    .mappings()
                    .one()
                )

        raise ValueError("Either speakerId or speakerName must be provided")

    def _save_updated_transcript_files(
        self,
        folder: Path,
        json_path: Path,
        transcript_art_path: str,
        updated_transcript: Transcript,
        is_array_format: bool,
    ) -> None:
        data_to_save = (
            [s.model_dump(exclude_none=True) for s in updated_transcript.segments]
            if is_array_format
            else updated_transcript.model_dump(exclude_none=True)
        )
        _atomic_write_text(json_path, f"{json.dumps(data_to_save, indent=2)}\n")
        txt_rel = re.sub(r"\.json$", ".txt", transcript_art_path)
        txt_path = folder / txt_rel
        _atomic_write_text(txt_path, f"{transcript_to_text(updated_transcript)}\n")

    async def reassign_meeting_speaker(self, options: dict[str, Any]) -> dict[str, Any]:
        meeting_id = str(options.get("meetingId") or options.get("meeting_id") or "")
        from_label = str(options.get("fromLabel") or options.get("from_label") or "")
        adopt_voiceprint = (
            bool(options["adoptVoiceprint"])
            if "adoptVoiceprint" in options and options["adoptVoiceprint"] is not None
            else True
        )
        current_time = self.now()

        meeting, transcript_art, folder, json_path, parsed_data = self._load_meeting_transcript_artifact(
            meeting_id, "reassign meeting transcript"
        )
        target_speaker_row = self._resolve_or_create_speaker(
            speaker_id=options.get("toSpeakerId") or options.get("to_speaker_id"),
            speaker_name=options.get("toSpeakerName") or options.get("to_speaker_name"),
            current_time=current_time,
        )

        extracted = _extract_transcript_segments(parsed_data)
        segments: list[TranscriptSegment] = extracted["segments"]
        is_array_format: bool = extracted["isArrayFormat"]
        normalized_from = from_label.strip().lower()

        updated_segments_count = 0
        extracted_voiceprints_count = 0
        voiceprint_status: VoiceprintEnrollmentStatus | None = None
        status_reason: str | None = None

        if adopt_voiceprint:
            extracted_ids: list[str] = []
            speaker_list = (
                (parsed_data.get("speakers") if isinstance(parsed_data, dict) else None)
                or extracted["speakers"]
                or []
            )
            for s in speaker_list:
                if not isinstance(s, dict):
                    continue
                lbl = str(s.get("label") or s.get("speaker") or "").strip().lower()
                if lbl == normalized_from and s.get("speaker_identifiers"):
                    for sid in list(s["speaker_identifiers"]):
                        if sid and sid not in extracted_ids:
                            extracted_ids.append(sid)

            if extracted_ids:
                extracted_voiceprints_count += len(extracted_ids)

            with self.db.connect() as conn:
                recording = (
                    conn.execute(
                        text(
                            "SELECT * FROM recordings WHERE meeting_id = :mid ORDER BY created_at ASC LIMIT 1"
                        ),
                        {"mid": meeting_id},
                    )
                    .mappings()
                    .first()
                )

            if recording:
                audio_full = folder / recording["path"]
                if audio_full.exists():
                    try:
                        audio_bytes = audio_full.read_bytes()
                        if len(audio_bytes) >= 12:
                            decoded = await load_audio_samples(
                                {
                                    "audioPath": str(audio_full),
                                    "audioBytes": audio_bytes,
                                    "enhance": False,
                                },
                                16000,
                            )
                            full_samples = decoded.samples
                            seg_idx_opt = options.get("segmentIndex")
                            is_single = seg_idx_opt is not None and options.get("scope") == "single"
                            matching_segs = (
                                [segments[int(seg_idx_opt)]]
                                if (
                                    is_single
                                    and seg_idx_opt is not None
                                    and 0 <= int(seg_idx_opt) < len(segments)
                                )
                                else [
                                    s
                                    for s in segments
                                    if (s.speaker or "").strip().lower() == normalized_from
                                ]
                            )
                            chunks: list[np.ndarray] = []
                            for seg in matching_segs:
                                s_start = int((seg.startMs / 1000.0) * 16000)
                                s_end = min(len(full_samples), int((seg.endMs / 1000.0) * 16000))
                                if s_end > s_start:
                                    chunks.append(full_samples[s_start:s_end])
                            if chunks:
                                merged_samples = np.concatenate(chunks)
                                clip_filename = f"clip_meeting_{meeting_id}_{current_time}.wav"
                                adopt_res = await self._adopt_voiceprint_sample(
                                    speaker_row=target_speaker_row,
                                    samples=merged_samples,
                                    sample_rate=16000,
                                    clip_filename=clip_filename,
                                    is_anchor=False,
                                    meeting_id=meeting_id,
                                    segment_index=seg_idx_opt,
                                )
                                voiceprint_status = adopt_res["status"]
                                status_reason = adopt_res.get("statusReason")
                                if adopt_res["voiceprintEnrolled"]:
                                    extracted_voiceprints_count += 1
                                    target_speaker_row = adopt_res["updatedSpeakerRow"]
                    except Exception as exc:
                        self.logger.warn(
                            "Could not extract audio clip during speaker reassignment",
                            {"meetingId": meeting_id, "error": str(exc)},
                        )

            if extracted_ids:
                with self.db.begin() as conn:
                    cur_row = (
                        conn.execute(
                            text("SELECT * FROM speakers WHERE id = :id"),
                            {"id": target_speaker_row["id"]},
                        )
                        .mappings()
                        .one()
                    )
                    cur_pids = _parse_json_field(cur_row.get("provider_ids"), {})
                    cur_sm = list(dict.fromkeys([*(cur_pids.get("speechmatics") or []), *extracted_ids]))
                    cur_pids["speechmatics"] = cur_sm
                    conn.execute(
                        text("UPDATE speakers SET provider_ids = :pids, enrolled_at = :eat WHERE id = :id"),
                        {
                            "pids": json.dumps(cur_pids),
                            "eat": cur_row.get("enrolled_at") or current_time,
                            "id": target_speaker_row["id"],
                        },
                    )
                    target_speaker_row = (
                        conn.execute(
                            text("SELECT * FROM speakers WHERE id = :id"),
                            {"id": target_speaker_row["id"]},
                        )
                        .mappings()
                        .one()
                    )

        seg_idx_opt = options.get("segmentIndex")
        is_single = seg_idx_opt is not None and options.get("scope") == "single"
        if is_single and seg_idx_opt is not None:
            idx = int(seg_idx_opt)
            if 0 <= idx < len(segments):
                tseg = segments[idx]
                tseg.speaker = target_speaker_row["name"]
                tseg.verified = True
                updated_segments_count += 1
                if tseg.words:
                    for w in tseg.words:
                        w.speaker = target_speaker_row["name"]
        else:
            for seg in segments:
                if seg.speaker and seg.speaker.strip().lower() == normalized_from:
                    seg.speaker = target_speaker_row["name"]
                    seg.verified = True
                    updated_segments_count += 1
                    if seg.words:
                        for w in seg.words:
                            w.speaker = target_speaker_row["name"]

        coalesced_segments = coalesce_speaker_segments(segments, 15000)
        updated_transcript = Transcript(
            segments=coalesced_segments,
            language=extracted["language"]
            or (parsed_data.get("language") if isinstance(parsed_data, dict) else None),
            durationMs=extracted["durationMs"]
            or (parsed_data.get("durationMs") if isinstance(parsed_data, dict) else None),
            speakers=extracted["speakers"]
            or (parsed_data.get("speakers") if isinstance(parsed_data, dict) else None),
        )

        self._save_updated_transcript_files(
            folder, json_path, transcript_art["path"], updated_transcript, is_array_format
        )

        with self.db.begin() as conn:
            conn.execute(
                text(
                    """
                    INSERT INTO meeting_speakers (meeting_id, speaker_id, evidence_artifact_id)
                    VALUES (:mid, :sid, :aid)
                    ON CONFLICT(meeting_id, speaker_id) DO UPDATE SET evidence_artifact_id = :aid
                    """
                ),
                {
                    "mid": meeting_id,
                    "sid": target_speaker_row["id"],
                    "aid": transcript_art["id"],
                },
            )

            if updated_transcript.segments:
                distinct_names = {
                    (s.speaker or "").strip().lower()
                    for s in updated_transcript.segments
                    if (s.speaker or "").strip()
                }
                cur_ms = (
                    conn.execute(
                        text(
                            """
                        SELECT speakers.id, speakers.name, speakers.enrolled_at,
                               speakers.enrollment_clip_paths
                        FROM meeting_speakers
                        INNER JOIN speakers ON speakers.id = meeting_speakers.speaker_id
                        WHERE meeting_speakers.meeting_id = :mid
                        """
                        ),
                        {"mid": meeting_id},
                    )
                    .mappings()
                    .all()
                )

                for sp in cur_ms:
                    if sp["name"].strip().lower() not in distinct_names:
                        conn.execute(
                            text(
                                "DELETE FROM meeting_speakers WHERE meeting_id = :mid AND speaker_id = :sid"
                            ),
                            {"mid": meeting_id, "sid": sp["id"]},
                        )
                        other_links = conn.execute(
                            text("SELECT 1 FROM meeting_speakers WHERE speaker_id = :sid LIMIT 1"),
                            {"sid": sp["id"]},
                        ).first()
                        is_placeholder = (
                            _is_placeholder_name(sp["name"]) or sp["name"].strip().lower() == normalized_from
                        )
                        clips = _parse_json_field(sp.get("enrollment_clip_paths"), [])
                        if not other_links and (is_placeholder or (not clips and not sp.get("enrolled_at"))):
                            conn.execute(
                                text("DELETE FROM speakers WHERE id = :sid"),
                                {"sid": sp["id"]},
                            )

        out: dict[str, Any] = {
            "speaker": _to_speaker_dict(target_speaker_row),
            "transcript": updated_transcript.model_dump(exclude_none=True),
            "updatedSegmentsCount": updated_segments_count,
            "extractedVoiceprintsCount": extracted_voiceprints_count,
        }
        if voiceprint_status is not None:
            out["voiceprintStatus"] = voiceprint_status
        if status_reason is not None:
            out["statusReason"] = status_reason
        return out

    reassignMeetingSpeaker = reassign_meeting_speaker

    async def confirm_meeting_segment_speaker(self, options: dict[str, Any]) -> dict[str, Any]:
        meeting_id = str(options.get("meetingId") or options.get("meeting_id") or "")
        segment_index = int(options["segmentIndex"])
        current_time = self.now()

        meeting, transcript_art, folder, json_path, parsed_data = self._load_meeting_transcript_artifact(
            meeting_id, "confirm meeting segment"
        )
        extracted = _extract_transcript_segments(parsed_data)
        segments: list[TranscriptSegment] = extracted["segments"]
        is_array_format: bool = extracted["isArrayFormat"]

        if segment_index < 0 or segment_index >= len(segments):
            raise ValueError(f"Invalid segment index {segment_index} (total {len(segments)})")

        segment = segments[segment_index]
        target_name = (
            (options.get("speakerName") or "").strip() or (segment.speaker or "").strip() or "Speaker"
        )
        target_speaker_row = self._resolve_or_create_speaker(
            speaker_id=options.get("speakerId"),
            speaker_name=target_name,
            current_time=current_time,
        )

        segment.speaker = target_speaker_row["name"]
        segment.verified = True
        if segment.words:
            for w in segment.words:
                w.speaker = target_speaker_row["name"]

        voiceprint_enrolled = False
        voiceprint_status: VoiceprintEnrollmentStatus = "not_available"
        status_reason: str | None = None
        similarity: float | None = None

        with self.db.connect() as conn:
            recording = (
                conn.execute(
                    text("SELECT * FROM recordings WHERE meeting_id = :mid ORDER BY created_at ASC LIMIT 1"),
                    {"mid": meeting_id},
                )
                .mappings()
                .first()
            )

        if recording:
            audio_full = folder / recording["path"]
            if audio_full.exists():
                try:
                    audio_bytes = audio_full.read_bytes()
                    if len(audio_bytes) >= 12:
                        decoded = await load_audio_samples(
                            {
                                "audioPath": str(audio_full),
                                "audioBytes": audio_bytes,
                                "enhance": False,
                            },
                            16000,
                        )
                        full_samples = decoded.samples
                        s_start = int((segment.startMs / 1000.0) * 16000)
                        s_end = min(len(full_samples), int((segment.endMs / 1000.0) * 16000))
                        if s_end > s_start:
                            seg_samples = full_samples[s_start:s_end]
                            clip_filename = (
                                f"clip_confirmed_meeting_{meeting_id}_{segment_index}_{current_time}.wav"
                            )
                            adopt_res = await self._adopt_voiceprint_sample(
                                speaker_row=target_speaker_row,
                                samples=seg_samples,
                                sample_rate=16000,
                                clip_filename=clip_filename,
                                is_anchor=False,
                                meeting_id=meeting_id,
                                segment_index=segment_index,
                            )
                            voiceprint_enrolled = adopt_res["voiceprintEnrolled"]
                            voiceprint_status = adopt_res["status"]
                            status_reason = adopt_res.get("statusReason")
                            similarity = adopt_res.get("similarity")
                            if voiceprint_enrolled:
                                target_speaker_row = adopt_res["updatedSpeakerRow"]
                except Exception as exc:
                    self.logger.warn(
                        "Could not extract audio clip during segment confirmation",
                        {"meetingId": meeting_id, "segmentIndex": segment_index, "error": str(exc)},
                    )

        updated_transcript = Transcript(
            segments=segments,
            language=extracted["language"]
            or (parsed_data.get("language") if isinstance(parsed_data, dict) else None),
            durationMs=extracted["durationMs"]
            or (parsed_data.get("durationMs") if isinstance(parsed_data, dict) else None),
            speakers=extracted["speakers"]
            or (parsed_data.get("speakers") if isinstance(parsed_data, dict) else None),
        )

        self._save_updated_transcript_files(
            folder, json_path, transcript_art["path"], updated_transcript, is_array_format
        )

        with self.db.begin() as conn:
            conn.execute(
                text(
                    """
                    INSERT INTO meeting_speakers (meeting_id, speaker_id, evidence_artifact_id)
                    VALUES (:mid, :sid, :aid)
                    ON CONFLICT(meeting_id, speaker_id) DO UPDATE SET evidence_artifact_id = :aid
                    """
                ),
                {
                    "mid": meeting_id,
                    "sid": target_speaker_row["id"],
                    "aid": transcript_art["id"],
                },
            )

        out: dict[str, Any] = {
            "speaker": _to_speaker_dict(target_speaker_row),
            "transcript": updated_transcript.model_dump(exclude_none=True),
            "segmentIndex": segment_index,
            "voiceprintEnrolled": voiceprint_enrolled,
            "voiceprintStatus": voiceprint_status,
        }
        if status_reason is not None:
            out["statusReason"] = status_reason
        if similarity is not None:
            out["similarity"] = similarity
        return out

    confirmMeetingSegmentSpeaker = confirm_meeting_segment_speaker

    async def unassign_meeting_segment_speaker(self, options: dict[str, Any]) -> dict[str, Any]:
        meeting_id = str(options.get("meetingId") or options.get("meeting_id") or "")
        segment_index = int(options["segmentIndex"])

        _meeting, transcript_art, folder, json_path, parsed_data = self._load_meeting_transcript_artifact(
            meeting_id, "unassign meeting segment"
        )
        extracted = _extract_transcript_segments(parsed_data)
        segments: list[TranscriptSegment] = extracted["segments"]
        is_array_format: bool = extracted["isArrayFormat"]

        if segment_index < 0 or segment_index >= len(segments):
            raise ValueError(f"Invalid segment index {segment_index} (total {len(segments)})")

        segment = segments[segment_index]
        segment.speaker = "Unknown"
        segment.verified = False
        if segment.words:
            for w in segment.words:
                w.speaker = "Unknown"

        updated_transcript = Transcript(
            segments=segments,
            language=extracted["language"]
            or (parsed_data.get("language") if isinstance(parsed_data, dict) else None),
            durationMs=extracted["durationMs"]
            or (parsed_data.get("durationMs") if isinstance(parsed_data, dict) else None),
            speakers=extracted["speakers"]
            or (parsed_data.get("speakers") if isinstance(parsed_data, dict) else None),
        )

        self._save_updated_transcript_files(
            folder, json_path, transcript_art["path"], updated_transcript, is_array_format
        )

        distinct_names = {(s.speaker or "").strip().lower() for s in segments if (s.speaker or "").strip()}
        with self.db.begin() as conn:
            linked = (
                conn.execute(
                    text(
                        """
                    SELECT speakers.id, speakers.name
                    FROM meeting_speakers
                    INNER JOIN speakers ON speakers.id = meeting_speakers.speaker_id
                    WHERE meeting_speakers.meeting_id = :mid
                    """
                    ),
                    {"mid": meeting_id},
                )
                .mappings()
                .all()
            )
            for spk in linked:
                if spk["name"].strip().lower() not in distinct_names:
                    conn.execute(
                        text("DELETE FROM meeting_speakers WHERE meeting_id = :mid AND speaker_id = :sid"),
                        {"mid": meeting_id, "sid": spk["id"]},
                    )

        return {
            "transcript": updated_transcript.model_dump(exclude_none=True),
            "segmentIndex": segment_index,
        }

    unassignMeetingSegmentSpeaker = unassign_meeting_segment_speaker

    async def split_meeting_segment(self, options: dict[str, Any]) -> dict[str, Any]:
        meeting_id = str(options.get("meetingId") or options.get("meeting_id") or "")
        segment_index = int(options["segmentIndex"])
        current_time = self.now()

        _meeting, transcript_art, folder, json_path, parsed_data = self._load_meeting_transcript_artifact(
            meeting_id, "split meeting segment"
        )
        extracted = _extract_transcript_segments(parsed_data)
        segments: list[TranscriptSegment] = extracted["segments"]
        is_array_format: bool = extracted["isArrayFormat"]

        if segment_index < 0 or segment_index >= len(segments):
            raise ValueError(f"Invalid segment index {segment_index} (total {len(segments)})")

        target_seg = segments[segment_index]
        new_speaker_name = (options.get("newSpeakerName") or "").strip()
        new_speaker_id = options.get("newSpeakerId")
        second_speaker_name = new_speaker_name or target_seg.speaker
        target_speaker_row: Mapping[Any, Any] | None = None

        if new_speaker_id or new_speaker_name:
            target_speaker_row = self._resolve_or_create_speaker(
                speaker_id=new_speaker_id,
                speaker_name=new_speaker_name,
                current_time=current_time,
            )
            second_speaker_name = target_speaker_row["name"]

        word_index = options.get("wordIndex")
        split_ms = options.get("splitMs")

        if target_seg.words and len(target_seg.words) > 0:
            n_words = len(target_seg.words)
            if word_index is not None:
                split_word_idx = max(1, min(n_words - 1, int(word_index)))
            elif split_ms is not None:
                found = next(
                    (i for i, w in enumerate(target_seg.words) if w.startMs >= int(split_ms)),
                    -1,
                )
                split_word_idx = found if found > 0 else (n_words // 2)
            else:
                split_word_idx = max(1, n_words // 2)

            words1 = [w.model_copy() for w in target_seg.words[:split_word_idx]]
            words2 = [w.model_copy() for w in target_seg.words[split_word_idx:]]
            end_ms1 = (
                words1[-1].endMs if words1 else int(round((target_seg.startMs + target_seg.endMs) / 2.0))
            )
            start_ms2 = words2[0].startMs if words2 else end_ms1

            if second_speaker_name != target_seg.speaker:
                for w in words2:
                    w.speaker = second_speaker_name

            first_seg = TranscriptSegment(
                startMs=target_seg.startMs,
                endMs=end_ms1,
                speaker=target_seg.speaker,
                text=" ".join(w.word for w in words1),
                verified=target_seg.verified,
                words=words1,
            )
            second_seg = TranscriptSegment(
                startMs=start_ms2,
                endMs=target_seg.endMs,
                speaker=second_speaker_name,
                text=" ".join(w.word for w in words2),
                verified=False,
                words=words2,
            )
        else:
            words = [w for w in re.split(r"\s+", target_seg.text.strip()) if w]
            if word_index is not None:
                split_word_idx = max(1, min(max(1, len(words) - 1), int(word_index)))
            elif split_ms is not None:
                ratio = max(
                    0.1,
                    min(
                        0.9,
                        (float(split_ms) - target_seg.startMs)
                        / max(1.0, float(target_seg.endMs - target_seg.startMs)),
                    ),
                )
                split_word_idx = max(1, min(max(1, len(words) - 1), int(round(ratio * len(words)))))
            else:
                split_word_idx = max(1, len(words) // 2)

            text1 = " ".join(words[:split_word_idx])
            text2 = " ".join(words[split_word_idx:])
            ratio = split_word_idx / float(max(1, len(words)))
            split_time = int(round(target_seg.startMs + ratio * (target_seg.endMs - target_seg.startMs)))

            first_seg = TranscriptSegment(
                startMs=target_seg.startMs,
                endMs=split_time,
                speaker=target_seg.speaker,
                text=text1,
                verified=target_seg.verified,
            )
            second_seg = TranscriptSegment(
                startMs=split_time,
                endMs=target_seg.endMs,
                speaker=second_speaker_name,
                text=text2,
                verified=False,
            )

        segments[segment_index : segment_index + 1] = [first_seg, second_seg]
        updated_transcript = Transcript(
            segments=segments,
            language=extracted["language"]
            or (parsed_data.get("language") if isinstance(parsed_data, dict) else None),
            durationMs=extracted["durationMs"]
            or (parsed_data.get("durationMs") if isinstance(parsed_data, dict) else None),
            speakers=extracted["speakers"]
            or (parsed_data.get("speakers") if isinstance(parsed_data, dict) else None),
        )

        self._save_updated_transcript_files(
            folder, json_path, transcript_art["path"], updated_transcript, is_array_format
        )

        if target_speaker_row:
            with self.db.begin() as conn:
                conn.execute(
                    text(
                        """
                        INSERT INTO meeting_speakers (meeting_id, speaker_id, evidence_artifact_id)
                        VALUES (:mid, :sid, :aid)
                        ON CONFLICT(meeting_id, speaker_id) DO UPDATE SET evidence_artifact_id = :aid
                        """
                    ),
                    {
                        "mid": meeting_id,
                        "sid": target_speaker_row["id"],
                        "aid": transcript_art["id"],
                    },
                )

        return {
            "transcript": updated_transcript.model_dump(exclude_none=True),
            "firstSegmentIndex": segment_index,
            "secondSegmentIndex": segment_index + 1,
        }

    splitMeetingSegment = split_meeting_segment

    async def merge_meeting_segments(self, options: dict[str, Any]) -> dict[str, Any]:
        meeting_id = str(options.get("meetingId") or options.get("meeting_id") or "")
        segment_index = int(options["segmentIndex"])

        _meeting, transcript_art, folder, json_path, parsed_data = self._load_meeting_transcript_artifact(
            meeting_id, "merge meeting segments"
        )
        extracted = _extract_transcript_segments(parsed_data)
        segments: list[TranscriptSegment] = extracted["segments"]
        is_array_format: bool = extracted["isArrayFormat"]

        if segment_index < 0 or segment_index >= len(segments) - 1:
            raise ValueError(
                f"Cannot merge segment {segment_index} with next (total segments: {len(segments)})"
            )

        seg_a = segments[segment_index]
        seg_b = segments[segment_index + 1]
        merged_words = [*(seg_a.words or []), *(seg_b.words or [])] if (seg_a.words or seg_b.words) else None
        merged_seg = TranscriptSegment(
            startMs=seg_a.startMs,
            endMs=max(seg_a.endMs, seg_b.endMs),
            speaker=seg_a.speaker,
            text=f"{seg_a.text.strip()} {seg_b.text.strip()}".strip(),
            verified=bool(seg_a.verified and seg_b.verified and seg_a.speaker == seg_b.speaker),
            words=merged_words,
        )

        segments[segment_index : segment_index + 2] = [merged_seg]
        updated_transcript = Transcript(
            segments=segments,
            language=extracted["language"]
            or (parsed_data.get("language") if isinstance(parsed_data, dict) else None),
            durationMs=extracted["durationMs"]
            or (parsed_data.get("durationMs") if isinstance(parsed_data, dict) else None),
            speakers=extracted["speakers"]
            or (parsed_data.get("speakers") if isinstance(parsed_data, dict) else None),
        )

        self._save_updated_transcript_files(
            folder, json_path, transcript_art["path"], updated_transcript, is_array_format
        )

        distinct_names = {(s.speaker or "").strip().lower() for s in segments if (s.speaker or "").strip()}
        with self.db.begin() as conn:
            linked = (
                conn.execute(
                    text(
                        """
                    SELECT speakers.id, speakers.name
                    FROM meeting_speakers
                    INNER JOIN speakers ON speakers.id = meeting_speakers.speaker_id
                    WHERE meeting_speakers.meeting_id = :mid
                    """
                    ),
                    {"mid": meeting_id},
                )
                .mappings()
                .all()
            )
            for spk in linked:
                if spk["name"].strip().lower() not in distinct_names:
                    conn.execute(
                        text("DELETE FROM meeting_speakers WHERE meeting_id = :mid AND speaker_id = :sid"),
                        {"mid": meeting_id, "sid": spk["id"]},
                    )

        return {
            "transcript": updated_transcript.model_dump(exclude_none=True),
            "segmentIndex": segment_index,
        }

    mergeMeetingSegments = merge_meeting_segments

    async def merge_speakers(self, source_speaker_id: str, target_speaker_id: str) -> dict[str, Any]:
        if source_speaker_id == target_speaker_id:
            raise ValueError("Cannot merge speaker with themselves")

        with self.db.connect() as conn:
            source = (
                conn.execute(
                    text("SELECT * FROM speakers WHERE id = :id"),
                    {"id": source_speaker_id},
                )
                .mappings()
                .first()
            )
            target = (
                conn.execute(
                    text("SELECT * FROM speakers WHERE id = :id"),
                    {"id": target_speaker_id},
                )
                .mappings()
                .first()
            )

        if not source:
            raise ValueError(f"Source speaker not found: {source_speaker_id}")
        if not target:
            raise ValueError(f"Target speaker not found: {target_speaker_id}")

        source_pids = _parse_json_field(source.get("provider_ids"), {})
        target_pids = _parse_json_field(target.get("provider_ids"), {})
        source_clips: list[str] = list(_parse_json_field(source.get("enrollment_clip_paths"), []))
        target_clips: list[str] = list(_parse_json_field(target.get("enrollment_clip_paths"), []))

        combined_sm = list(
            dict.fromkeys(
                [*(target_pids.get("speechmatics") or []), *(source_pids.get("speechmatics") or [])]
            )
        )
        if combined_sm:
            target_pids["speechmatics"] = combined_sm

        combined_local = list(
            dict.fromkeys([*(target_pids.get("local") or []), *(source_pids.get("local") or [])])
        )
        if combined_local:
            target_pids["local"] = combined_local

        combined_clips = list(dict.fromkeys([*target_clips, *source_clips]))
        if len(combined_clips) > MAX_ENROLLMENT_CLIPS:
            anchor = combined_clips[0]
            other_clips = combined_clips[1:]
            keep_count = MAX_ENROLLMENT_CLIPS - 1
            kept_others = other_clips[-keep_count:]
            evicted_others = other_clips[:-keep_count]
            for evicted_rel in evicted_others:
                try:
                    (Path(self.config_dir) / evicted_rel).unlink(missing_ok=True)
                except Exception:
                    pass
            combined_clips = [anchor, *kept_others]

        enrolled_at = target.get("enrolled_at") or source.get("enrolled_at")

        with self.db.begin() as conn:
            conn.execute(
                text(
                    """
                    UPDATE speakers
                    SET provider_ids = :pids, enrollment_clip_paths = :clips, enrolled_at = :eat
                    WHERE id = :id
                    """
                ),
                {
                    "pids": json.dumps(target_pids),
                    "clips": json.dumps(combined_clips),
                    "eat": enrolled_at,
                    "id": target_speaker_id,
                },
            )
            source_links = (
                conn.execute(
                    text("SELECT * FROM meeting_speakers WHERE speaker_id = :sid"),
                    {"sid": source_speaker_id},
                )
                .mappings()
                .all()
            )
            for link in source_links:
                conn.execute(
                    text(
                        """
                        INSERT INTO meeting_speakers (meeting_id, speaker_id, evidence_artifact_id)
                        VALUES (:mid, :sid, :aid)
                        ON CONFLICT(meeting_id, speaker_id) DO UPDATE SET evidence_artifact_id = :aid
                        """
                    ),
                    {
                        "mid": link["meeting_id"],
                        "sid": target_speaker_id,
                        "aid": link["evidence_artifact_id"],
                    },
                )
            conn.execute(
                text("DELETE FROM meeting_speakers WHERE speaker_id = :sid"),
                {"sid": source_speaker_id},
            )
            conn.execute(
                text("DELETE FROM speakers WHERE id = :sid"),
                {"sid": source_speaker_id},
            )
            updated_target = (
                conn.execute(
                    text("SELECT * FROM speakers WHERE id = :id"),
                    {"id": target_speaker_id},
                )
                .mappings()
                .one()
            )

        return _to_speaker_dict(updated_target)

    mergeSpeakers = merge_speakers

    async def enroll_speaker(self, options: dict[str, Any]) -> dict[str, Any]:
        current_time = self.now()
        name = str(options.get("name") or "").strip()
        if not name:
            raise ValueError("Speaker name is required")

        audio_bytes = bytes(options.get("audioBytes") or options.get("audio_bytes") or b"")
        speaker_id_opt = options.get("speakerId") or options.get("speaker_id")

        with self.db.connect() as conn:
            speaker_row: Mapping[Any, Any] | None = None
            if speaker_id_opt:
                speaker_row = (
                    conn.execute(
                        text("SELECT * FROM speakers WHERE id = :id"),
                        {"id": speaker_id_opt},
                    )
                    .mappings()
                    .first()
                )
            else:
                all_rows = conn.execute(text("SELECT * FROM speakers")).mappings().all()
                speaker_row = next(
                    (s for s in all_rows if s["name"].strip().lower() == name.lower()),
                    None,
                )

        speaker_id = speaker_row["id"] if speaker_row else str(speaker_id_opt or uuid.uuid4())

        # 1. Validate audio duration & deduplicate by content hash
        decoded = await load_audio_samples({"audioBytes": audio_bytes, "enhance": False}, 16000)
        duration_sec = len(decoded.samples) / 16000.0
        if duration_sec < 2.5:
            raise ValueError(
                f"Enrollment audio clip duration too short ({duration_sec:.1f}s). Must be between 3 and 30 seconds."
            )
        if duration_sec > 35.0:
            raise ValueError(
                f"Enrollment audio clip duration too long ({duration_sec:.1f}s). Must be between 3 and 30 seconds to ensure single-speaker sample."
            )

        clip_hash = hashlib.sha256(audio_bytes).hexdigest()

        with self.db.connect() as conn:
            all_db_speakers = conn.execute(text("SELECT * FROM speakers")).mappings().all()

        for other_spk in all_db_speakers:
            if other_spk["id"] == speaker_id:
                continue
            other_clips = _parse_json_field(other_spk.get("enrollment_clip_paths"), [])
            for other_rel in other_clips:
                other_full = Path(self.config_dir) / other_rel
                if other_full.exists():
                    other_bytes = other_full.read_bytes()
                    if hashlib.sha256(other_bytes).hexdigest() == clip_hash:
                        raise ValueError(
                            f'Cannot enroll clip: exact audio content is already enrolled under speaker "{other_spk["name"]}"'
                        )

        # 2. Save enrollment clip to disk
        filename_opt = options.get("filename")
        ext = Path(str(filename_opt)).suffix.lstrip(".") if filename_opt else "wav"
        ext = ext or "wav"
        speaker_folder = Path(self.config_dir) / "speakers" / speaker_id
        speaker_folder.mkdir(parents=True, exist_ok=True)
        clip_filename = f"clip_{current_time}.{ext}"
        clip_rel_path = f"speakers/{speaker_id}/{clip_filename}"
        (Path(self.config_dir) / clip_rel_path).write_bytes(audio_bytes)

        existing_pids: dict[str, list[str]] = (
            _parse_json_field(speaker_row.get("provider_ids"), {}) if speaker_row else {}
        )
        existing_clips: list[str] = (
            list(_parse_json_field(speaker_row.get("enrollment_clip_paths"), [])) if speaker_row else []
        )
        existing_local: list[str] = list(existing_pids.get("local") or [])

        if len(existing_clips) >= MAX_ENROLLMENT_CLIPS and len(existing_clips) > 1:
            evicted_rel = existing_clips.pop(1)
            if len(existing_local) > 1:
                existing_local.pop(1)
            try:
                (Path(self.config_dir) / evicted_rel).unlink(missing_ok=True)
            except Exception as exc:
                self.logger.warn(
                    "Could not delete evicted enrollment clip",
                    {"path": evicted_rel, "error": str(exc)},
                )

        if clip_rel_path not in existing_clips:
            existing_clips.append(clip_rel_path)

        provider_mode = options.get("provider") or "both"

        # 3. Extract Neural Speaker Embedding Vector
        if provider_mode in ("local", "both"):
            try:
                local_emb = await self.local_embedding_extractor.extract(decoded.samples, 16000)
                existing_local.append(json.dumps(local_emb))
                existing_pids["local"] = existing_local
            except Exception as exc:
                self.logger.warn(
                    "Could not compute local voiceprint from audio clip",
                    {"error": str(exc)},
                )

        # 4. Submit enrollment job to Speechmatics if available
        if provider_mode in ("speechmatics", "both"):
            try:
                submit_res = await self.client.submit_job(
                    {
                        "audio": audio_bytes,
                        "filename": filename_opt or clip_filename,
                        "mime": options.get("mime") or "audio/wav",
                        "language": options.get("language") or "en",
                        "getSpeakers": True,
                    }
                )
                poll_interval_ms = int(options.get("pollIntervalMs") or 2000)
                max_wait_ms = int(options.get("maxPollWaitMs") or 180_000)
                start_time = self.now()
                json_v2: dict[str, Any] | None = None

                while self.now() - start_time < max_wait_ms:
                    st = await self.client.get_job(submit_res["id"])
                    if st.get("status") == "done":
                        json_v2 = await self.client.get_transcript(submit_res["id"], "json-v2")
                        break
                    if st.get("status") in ("rejected", "deleted"):
                        errs = st.get("errors") or []
                        err_msg = (
                            "; ".join(e.get("message", "") for e in errs)
                            if errs
                            else f"Enrollment job {st.get('status')}"
                        )
                        raise RuntimeError(f"Speechmatics enrollment failed: {err_msg}")
                    await asyncio.sleep(poll_interval_ms / 1000.0)

                if json_v2:
                    extracted_identifiers: list[str] = []
                    for s in json_v2.get("speakers") or []:
                        if isinstance(s, dict):
                            for sid in list(s.get("speaker_identifiers") or []):
                                if sid and sid not in extracted_identifiers:
                                    extracted_identifiers.append(sid)
                    existing_pids["speechmatics"] = list(
                        dict.fromkeys([*(existing_pids.get("speechmatics") or []), *extracted_identifiers])
                    )
                    try:
                        await self.client.delete_job(submit_res["id"])
                    except Exception:
                        pass
            except Exception as sm_err:
                if provider_mode == "speechmatics":
                    raise
                self.logger.warn(
                    "Speechmatics enrollment failed during multi-provider enroll",
                    {"error": str(sm_err)},
                )

        with self.db.begin() as conn:
            if speaker_row:
                conn.execute(
                    text(
                        """
                        UPDATE speakers
                        SET name = :name, provider_ids = :pids, enrolled_at = :eat,
                            enrollment_clip_paths = :clips
                        WHERE id = :id
                        """
                    ),
                    {
                        "name": name,
                        "pids": json.dumps(existing_pids),
                        "eat": current_time,
                        "clips": json.dumps(existing_clips),
                        "id": speaker_row["id"],
                    },
                )
            else:
                conn.execute(
                    text(
                        """
                        INSERT INTO speakers (
                          id, name, provider_ids, enrolled_at, enrollment_clip_paths, created_at
                        ) VALUES (:id, :name, :pids, :eat, :clips, :now)
                        """
                    ),
                    {
                        "id": speaker_id,
                        "name": name,
                        "pids": json.dumps(existing_pids),
                        "eat": current_time,
                        "clips": json.dumps(existing_clips),
                        "now": current_time,
                    },
                )
            updated = (
                conn.execute(
                    text("SELECT * FROM speakers WHERE id = :id"),
                    {"id": speaker_id},
                )
                .mappings()
                .one()
            )

        return _to_speaker_dict(updated)

    enrollSpeaker = enroll_speaker

    async def link_meeting_speaker(self, options: dict[str, Any]) -> dict[str, Any]:
        meeting_id = str(options.get("meetingId") or options.get("meeting_id") or "")
        speaker_id = str(options.get("speakerId") or options.get("speaker_id") or "")
        speechmatics_label = options.get("speechmaticsLabel") or options.get("speechmatics_label")

        with self.db.begin() as conn:
            speaker_row = (
                conn.execute(
                    text("SELECT * FROM speakers WHERE id = :id"),
                    {"id": speaker_id},
                )
                .mappings()
                .first()
            )
            if not speaker_row:
                raise ValueError(f"Speaker not found: {speaker_id}")

            meeting_row = (
                conn.execute(
                    text("SELECT * FROM meetings WHERE id = :id"),
                    {"id": meeting_id},
                )
                .mappings()
                .first()
            )
            if not meeting_row:
                raise ValueError(f"Meeting not found: {meeting_id}")

            conn.execute(
                text(
                    """
                    INSERT INTO meeting_speakers (meeting_id, speaker_id, evidence_artifact_id)
                    VALUES (:mid, :sid, :aid)
                    ON CONFLICT(meeting_id, speaker_id) DO UPDATE SET evidence_artifact_id = :aid
                    """
                ),
                {
                    "mid": meeting_id,
                    "sid": speaker_id,
                    "aid": meeting_row.get("primary_transcript_artifact_id"),
                },
            )

            if speechmatics_label and self.meetings_dir:
                folder = Path(
                    meeting_paths(
                        self.meetings_dir,
                        int(meeting_row["start_time"]),
                        meeting_row["title"],
                        meeting_row["id"],
                    ).folder
                )
                t_art = (
                    conn.execute(
                        text(
                            """
                        SELECT * FROM artifacts
                        WHERE meeting_id = :mid AND provider = 'speechmatics'
                          AND kind = 'transcript' AND format = 'json'
                        LIMIT 1
                        """
                        ),
                        {"mid": meeting_id},
                    )
                    .mappings()
                    .first()
                )
                if t_art:
                    try:
                        parsed = json.loads((folder / t_art["path"]).read_text(encoding="utf-8"))
                        if isinstance(parsed, dict) and isinstance(parsed.get("speakers"), list):
                            match = next(
                                (
                                    s
                                    for s in parsed["speakers"]
                                    if isinstance(s, dict)
                                    and str(s.get("label") or s.get("speaker") or "").strip()
                                    == str(speechmatics_label).strip()
                                ),
                                None,
                            )
                            if match and match.get("speaker_identifiers"):
                                ids = list(match["speaker_identifiers"])
                                pids = _parse_json_field(speaker_row.get("provider_ids"), {})
                                pids["speechmatics"] = list(
                                    dict.fromkeys([*(pids.get("speechmatics") or []), *ids])
                                )
                                conn.execute(
                                    text(
                                        "UPDATE speakers SET provider_ids = :pids, enrolled_at = :eat WHERE id = :id"
                                    ),
                                    {
                                        "pids": json.dumps(pids),
                                        "eat": speaker_row.get("enrolled_at") or self.now(),
                                        "id": speaker_id,
                                    },
                                )
                    except Exception:
                        pass

            updated = (
                conn.execute(
                    text("SELECT * FROM speakers WHERE id = :id"),
                    {"id": speaker_id},
                )
                .mappings()
                .one()
            )

        return {"speaker": _to_speaker_dict(updated)}

    linkMeetingSpeaker = link_meeting_speaker

    async def update_speaker(self, speaker_id: str, updates: dict[str, Any]) -> dict[str, Any]:
        sets: list[str] = []
        params: dict[str, Any] = {"id": speaker_id}
        if "name" in updates and updates["name"] is not None:
            sets.append("name = :name")
            params["name"] = str(updates["name"]).strip()
        if "providerIds" in updates and updates["providerIds"] is not None:
            sets.append("provider_ids = :pids")
            params["pids"] = json.dumps(updates["providerIds"])

        with self.db.begin() as conn:
            if sets:
                conn.execute(
                    text(f"UPDATE speakers SET {', '.join(sets)} WHERE id = :id"),
                    params,
                )
            updated = (
                conn.execute(
                    text("SELECT * FROM speakers WHERE id = :id"),
                    {"id": speaker_id},
                )
                .mappings()
                .one()
            )
        return _to_speaker_dict(updated)

    updateSpeaker = update_speaker

    async def delete_speaker(self, speaker_id: str) -> None:
        with self.db.begin() as conn:
            conn.execute(
                text("DELETE FROM meeting_speakers WHERE speaker_id = :id"),
                {"id": speaker_id},
            )
            conn.execute(
                text("DELETE FROM speakers WHERE id = :id"),
                {"id": speaker_id},
            )

    deleteSpeaker = delete_speaker

    def sync_meeting_speakers_and_transcripts_sync(self) -> dict[str, int]:
        if not self.meetings_dir:
            return {"repairedMeetings": 0, "prunedSpeakers": 0}

        repaired_meetings = 0
        pruned_speakers = 0

        with self.db.begin() as conn:
            meetings = conn.execute(text("SELECT * FROM meetings")).mappings().all()
            all_artifacts = (
                conn.execute(text("SELECT * FROM artifacts WHERE kind = 'transcript'")).mappings().all()
            )

            for meeting in meetings:
                primary_id = meeting.get("primary_transcript_artifact_id")
                primary_t = (
                    next((a for a in all_artifacts if a["id"] == primary_id), None)
                    if primary_id
                    else next(
                        (
                            a
                            for a in all_artifacts
                            if a["meeting_id"] == meeting["id"] and a["format"] == "json"
                        ),
                        None,
                    )
                )
                if not primary_t or primary_t["format"] != "json":
                    continue

                folder = Path(
                    meeting_paths(
                        self.meetings_dir,
                        int(meeting["start_time"]),
                        meeting["title"],
                        meeting["id"],
                    ).folder
                )
                json_path = folder / primary_t["path"]
                if not json_path.exists():
                    continue

                try:
                    parsed = json.loads(json_path.read_text(encoding="utf-8"))
                    ext = _extract_transcript_segments(parsed)
                    segments = ext["segments"]
                    if segments:
                        coalesced = coalesce_speaker_segments(segments, 15000)
                        if len(coalesced) != len(segments):
                            self._save_updated_transcript_files(
                                folder,
                                json_path,
                                primary_t["path"],
                                Transcript(segments=coalesced),
                                ext["isArrayFormat"],
                            )
                            repaired_meetings += 1
                except Exception:
                    pass

            all_speakers = conn.execute(text("SELECT * FROM speakers")).mappings().all()
            for s in all_speakers:
                is_placeholder = _is_placeholder_name(s["name"])
                links = conn.execute(
                    text("SELECT 1 FROM meeting_speakers WHERE speaker_id = :sid LIMIT 1"),
                    {"sid": s["id"]},
                ).first()
                clips = _parse_json_field(s.get("enrollment_clip_paths"), [])
                if not links and (is_placeholder or (not clips and not s.get("enrolled_at"))):
                    conn.execute(
                        text("DELETE FROM speakers WHERE id = :id"),
                        {"id": s["id"]},
                    )
                    pruned_speakers += 1

        return {"repairedMeetings": repaired_meetings, "prunedSpeakers": pruned_speakers}

    async def sync_meeting_speakers_and_transcripts(self) -> dict[str, int]:
        return self.sync_meeting_speakers_and_transcripts_sync()

    syncMeetingSpeakersAndTranscripts = sync_meeting_speakers_and_transcripts
