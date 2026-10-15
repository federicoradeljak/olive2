"""Meetings CRUD and detail aggregation service (port of packages/server/src/meetings.ts)."""

from __future__ import annotations

import json
import shutil
import time
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Engine

from ..layout import meeting_paths
from ..schemas import (
    Artifact,
    MeetingDetailAggregate,
    MeetingListItem,
    MeetingSummaryItem,
    Recording,
    Speaker,
    StageRunRow,
)
from ..speaker_labels import is_generic_speaker_label

DEFAULT_LIMIT = 50
MAX_LIMIT = 100


def parse_tags(value: str | None) -> list[str]:
    if not value:
        return []
    try:
        parsed = json.loads(value)
        if isinstance(parsed, list) and all(isinstance(item, str) for item in parsed):
            return parsed
    except Exception:
        pass
    return []


def parse_json_field(value: str | None, fallback: Any) -> Any:
    if not value:
        return fallback
    try:
        return json.loads(value)
    except Exception:
        return fallback


def to_meeting(row: Mapping[Any, Any]) -> MeetingListItem:
    return MeetingListItem(
        id=row["id"],
        title=row["title"],
        startTime=int(row["start_time"]),
        endTime=int(row["end_time"]),
        source=row["source"],
        status=row["status"],
        tags=parse_tags(row.get("tags")),
        primaryTranscriptArtifactId=row.get("primary_transcript_artifact_id"),
        primarySummaryArtifactId=row.get("primary_summary_artifact_id"),
        lastError=row.get("last_error"),
        createdAt=int(row["created_at"]),
        updatedAt=int(row["updated_at"]),
    )


def to_recording(row: Mapping[Any, Any]) -> Recording:
    return Recording(
        id=row["id"],
        meetingId=row["meeting_id"],
        path=row["path"],
        mime=row["mime"],
        durationMs=int(row["duration_ms"]) if row.get("duration_ms") is not None else None,
        sizeBytes=int(row["size_bytes"]),
        sha256=row["sha256"],
        provider=row["provider"],
        providerRecordingId=row.get("provider_recording_id"),
        createdAt=int(row["created_at"]),
    )


def to_artifact(row: Mapping[Any, Any]) -> Artifact:
    return Artifact(
        id=row["id"],
        meetingId=row["meeting_id"],
        recordingId=row.get("recording_id"),
        kind=row["kind"],
        provider=row["provider"],
        format=row["format"],
        path=row["path"],
        createdAt=int(row["created_at"]),
    )


def to_speaker(row: Mapping[Any, Any]) -> Speaker:
    return Speaker(
        id=row["id"],
        name=row["name"],
        providerIds=parse_json_field(row.get("provider_ids"), {}),
        enrolledAt=int(row["enrolled_at"]) if row.get("enrolled_at") is not None else None,
        enrollmentClipPaths=parse_json_field(row.get("enrollment_clip_paths"), []),
        createdAt=int(row["created_at"]),
    )


def list_meetings(
    db: Engine,
    query: dict[str, Any] | None = None,
    meetings_dir: str | None = None,
) -> dict[str, Any]:
    q = query or {}
    raw_limit = q.get("limit")
    raw_offset = q.get("offset")
    limit = min(max(int(raw_limit if raw_limit is not None else DEFAULT_LIMIT), 1), MAX_LIMIT)
    offset = max(int(raw_offset if raw_offset is not None else 0), 0)
    search = (q.get("search") or "").strip()
    source = q.get("source")
    start_time = q.get("startTime") if q.get("startTime") is not None else q.get("start_time")
    end_time = q.get("endTime") if q.get("endTime") is not None else q.get("end_time")

    matching_ids: set[str] | None = None

    with db.connect() as conn:
        if search:
            matching_ids = set()
            pattern = f"%{search}%"
            title_tag_rows = conn.execute(
                text("SELECT id FROM meetings WHERE title LIKE :pat OR tags LIKE :pat"),
                {"pat": pattern},
            ).mappings().all()
            for m in title_tag_rows:
                matching_ids.add(m["id"])

            if meetings_dir:
                content_artifacts = conn.execute(
                    text(
                        """
                        SELECT artifacts.meeting_id, artifacts.path, meetings.start_time,
                               meetings.title, meetings.id AS m_id
                        FROM artifacts
                        INNER JOIN meetings ON meetings.id = artifacts.meeting_id
                        WHERE artifacts.kind IN ('transcript', 'summary')
                        """
                    )
                ).mappings().all()
                search_lower = search.lower()
                for a in content_artifacts:
                    if a["meeting_id"] in matching_ids:
                        continue
                    try:
                        folder = meeting_paths(
                            meetings_dir, int(a["start_time"]), a["title"], a["m_id"]
                        ).folder
                        full_path = Path(folder) / a["path"]
                        if full_path.exists():
                            txt = full_path.read_text(encoding="utf-8", errors="ignore")
                            if search_lower in txt.lower():
                                matching_ids.add(a["meeting_id"])
                    except Exception:
                        pass

        where_clauses: list[str] = []
        params: dict[str, Any] = {"limit": limit, "offset": offset}

        if matching_ids is not None:
            if not matching_ids:
                where_clauses.append("id = '__no_match__'")
            else:
                id_placeholders = []
                for idx, mid in enumerate(sorted(matching_ids)):
                    pname = f"mid_{idx}"
                    id_placeholders.append(f":{pname}")
                    params[pname] = mid
                where_clauses.append(f"id IN ({', '.join(id_placeholders)})")

        if source:
            where_clauses.append("source = :source")
            params["source"] = source
        if start_time is not None:
            where_clauses.append("start_time >= :start_time")
            params["start_time"] = int(start_time)
        if end_time is not None:
            where_clauses.append("start_time <= :end_time")
            params["end_time"] = int(end_time)

        where_sql = f"WHERE {' AND '.join(where_clauses)}" if where_clauses else ""

        rows = conn.execute(
            text(f"SELECT * FROM meetings {where_sql} ORDER BY start_time DESC LIMIT :limit OFFSET :offset"),
            params,
        ).mappings().all()

        total = conn.execute(
            text(f"SELECT COUNT(id) FROM meetings {where_sql}"),
            params,
        ).scalar()

    return {
        "meetings": [to_meeting(r).model_dump() for r in rows],
        "pagination": {
            "limit": limit,
            "offset": offset,
            "total": int(total or 0),
        },
    }


def update_meeting_tags(db: Engine, meeting_id: str, tags: list[str]) -> MeetingListItem | None:
    seen: list[str] = []
    for t in tags:
        s = t.strip()
        if s and s not in seen:
            seen.append(s)
    now = int(time.time() * 1000)

    with db.begin() as conn:
        conn.execute(
            text("UPDATE meetings SET tags = :tags, updated_at = :now WHERE id = :id"),
            {"tags": json.dumps(seen), "now": now, "id": meeting_id},
        )
        row = conn.execute(
            text("SELECT * FROM meetings WHERE id = :id"),
            {"id": meeting_id},
        ).mappings().first()

    return to_meeting(row) if row else None


def update_meeting_title(
    db: Engine,
    meeting_id: str,
    title: str,
    meetings_dir: str | None = None,
) -> MeetingListItem | None:
    normalized = title.strip()
    if not normalized:
        raise ValueError("title must be a non-empty string")

    with db.connect() as conn:
        meeting = conn.execute(
            text("SELECT * FROM meetings WHERE id = :id"),
            {"id": meeting_id},
        ).mappings().first()

    if not meeting:
        return None
    if meeting["title"] == normalized:
        return to_meeting(meeting)

    old_folder = (
        Path(meeting_paths(meetings_dir, int(meeting["start_time"]), meeting["title"], meeting["id"]).folder)
        if meetings_dir
        else None
    )
    new_folder = (
        Path(meeting_paths(meetings_dir, int(meeting["start_time"]), normalized, meeting["id"]).folder)
        if meetings_dir
        else None
    )
    moved_folder = bool(
        old_folder and new_folder and old_folder != new_folder and old_folder.exists()
    )

    if moved_folder and old_folder and new_folder:
        if new_folder.exists():
            raise RuntimeError("Meeting folder already exists")
        old_folder.rename(new_folder)

    try:
        now = int(time.time() * 1000)
        with db.begin() as conn:
            res = conn.execute(
                text(
                    "UPDATE meetings SET title = :title, updated_at = :now "
                    "WHERE id = :id AND title = :old_title"
                ),
                {
                    "title": normalized,
                    "now": now,
                    "id": meeting_id,
                    "old_title": meeting["title"],
                },
            )
            if res.rowcount != 1:
                raise RuntimeError("Meeting was changed while it was being renamed")
            updated_row = conn.execute(
                text("SELECT * FROM meetings WHERE id = :id"),
                {"id": meeting_id},
            ).mappings().first()
    except Exception:
        if moved_folder and old_folder and new_folder and new_folder.exists():
            try:
                new_folder.rename(old_folder)
            except Exception:
                pass
        raise

    return to_meeting(updated_row) if updated_row else None


def get_meeting(
    db: Engine,
    meeting_id: str,
    meetings_dir: str | None = None,
) -> MeetingDetailAggregate | None:
    with db.connect() as conn:
        meeting_row = conn.execute(
            text("SELECT * FROM meetings WHERE id = :id"),
            {"id": meeting_id},
        ).mappings().first()
        if not meeting_row:
            return None

        recording_rows = conn.execute(
            text("SELECT * FROM recordings WHERE meeting_id = :id ORDER BY created_at ASC"),
            {"id": meeting_id},
        ).mappings().all()
        artifact_rows = conn.execute(
            text("SELECT * FROM artifacts WHERE meeting_id = :id ORDER BY created_at ASC"),
            {"id": meeting_id},
        ).mappings().all()
        ms_rows = conn.execute(
            text("SELECT * FROM meeting_speakers WHERE meeting_id = :id"),
            {"id": meeting_id},
        ).mappings().all()
        stage_run_rows = conn.execute(
            text("SELECT * FROM stage_runs WHERE meeting_id = :id ORDER BY created_at ASC"),
            {"id": meeting_id},
        ).mappings().all()

        speaker_ids = [r["speaker_id"] for r in ms_rows]
        speaker_rows: list[Mapping[Any, Any]] = []
        if speaker_ids:
            placeholders = ", ".join(f":sid_{i}" for i in range(len(speaker_ids)))
            sparams = {f"sid_{i}": sid for i, sid in enumerate(speaker_ids)}
            speaker_rows = list(
                conn.execute(
                    text(f"SELECT * FROM speakers WHERE id IN ({placeholders})"),
                    sparams,
                ).mappings().all()
            )

    transcript_content: str | None = None
    summary_content: str | None = None
    summaries: list[MeetingSummaryItem] = []

    if meetings_dir:
        folder = Path(
            meeting_paths(
                meetings_dir,
                int(meeting_row["start_time"]),
                meeting_row["title"],
                meeting_row["id"],
            ).folder
        )
        primary_t_id = meeting_row.get("primary_transcript_artifact_id")
        primary_transcript = next((a for a in artifact_rows if a["id"] == primary_t_id), None)
        if primary_transcript:
            try:
                transcript_content = (folder / primary_transcript["path"]).read_text(encoding="utf-8")
            except Exception:
                pass

        primary_s_id = meeting_row.get("primary_summary_artifact_id")
        primary_summary = next((a for a in artifact_rows if a["id"] == primary_s_id), None)
        if primary_summary:
            try:
                summary_content = (folder / primary_summary["path"]).read_text(encoding="utf-8")
            except Exception:
                pass

        for sa in artifact_rows:
            if sa["kind"] != "summary":
                continue
            try:
                content = (folder / sa["path"]).read_text(encoding="utf-8")
                summaries.append(
                    MeetingSummaryItem(
                        id=sa["id"],
                        provider=sa["provider"],
                        format=sa["format"],
                        path=sa["path"],
                        createdAt=int(sa["created_at"]),
                        content=content,
                        isPrimary=sa["id"] == primary_s_id,
                    )
                )
            except Exception:
                pass

    summaries.sort(key=lambda s: s.createdAt, reverse=True)

    active_speaker_rows = list(speaker_rows)
    if transcript_content:
        try:
            parsed = json.loads(transcript_content)
            segs_raw: list[Any] = (
                parsed.get("segments")
                if isinstance(parsed, dict) and isinstance(parsed.get("segments"), list)
                else parsed
                if isinstance(parsed, list)
                else []
            ) or []
            names_in_transcript = {
                str(s.get("speaker") or s.get("name") or "").strip().lower()
                for s in segs_raw
                if isinstance(s, dict) and str(s.get("speaker") or s.get("name") or "").strip()
            }
            if names_in_transcript:
                active_speaker_rows = [
                    s for s in speaker_rows if str(s["name"]).strip().lower() in names_in_transcript
                ]
        except Exception:
            pass

    # Generic labels ("Speaker 1", ...) are transcript labels, not people:
    # never surface them as meeting speakers (covers rows persisted earlier).
    active_speaker_rows = [
        s for s in active_speaker_rows if not is_generic_speaker_label(str(s["name"]))
    ]

    return MeetingDetailAggregate(
        meeting=to_meeting(meeting_row),
        recordings=[to_recording(r) for r in recording_rows],
        artifacts=[to_artifact(a) for a in artifact_rows],
        speakers=[to_speaker(s) for s in active_speaker_rows],
        stageRuns=[StageRunRow.model_validate(dict(sr)) for sr in stage_run_rows],
        transcriptContent=transcript_content,
        summaryContent=summary_content,
        summaries=summaries,
    )


def delete_meeting(db: Engine, meeting_id: str, meetings_dir: str | None = None) -> bool:
    with db.connect() as conn:
        meeting_row = conn.execute(
            text("SELECT * FROM meetings WHERE id = :id"),
            {"id": meeting_id},
        ).mappings().first()
    if not meeting_row:
        return False

    with db.begin() as conn:
        conn.execute(
            text(
                "UPDATE meetings SET primary_transcript_artifact_id = NULL, "
                "primary_summary_artifact_id = NULL WHERE id = :id"
            ),
            {"id": meeting_id},
        )
        conn.execute(
            text(
                "UPDATE plaud_ingest_state SET duplicate_of_meeting_id = NULL "
                "WHERE duplicate_of_meeting_id = :id"
            ),
            {"id": meeting_id},
        )
        conn.execute(
            text("UPDATE usage_events SET meeting_id = NULL WHERE meeting_id = :id"),
            {"id": meeting_id},
        )
        for tbl in [
            "meeting_speakers",
            "stage_runs",
            "plaud_ingest_state",
            "chat_messages",
            "logs",
            "artifacts",
            "recordings",
        ]:
            conn.execute(text(f"DELETE FROM {tbl} WHERE meeting_id = :id"), {"id": meeting_id})
        conn.execute(text("DELETE FROM meetings WHERE id = :id"), {"id": meeting_id})

    if meetings_dir:
        folder = Path(
            meeting_paths(
                meetings_dir,
                int(meeting_row["start_time"]),
                meeting_row["title"],
                meeting_row["id"],
            ).folder
        )
        shutil.rmtree(folder, ignore_errors=True)

    return True
