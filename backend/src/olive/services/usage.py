"""API spend / usage tracking for cloud transcription and LLM calls.

Transcription vendors bill per hour of audio (AssemblyAI / Speechmatics) while
LLM providers bill per token, so this module records a small ``usage_events``
row every time Olive spends money (or free local compute) on a meeting and
aggregates those rows into month / per-meeting spend summaries for the UI.

Costs are *estimates* from public rate cards, shown alongside the rates used,
so users can sanity-check them against provider dashboards.
"""

from __future__ import annotations

import json
import re
import time
import uuid
from datetime import UTC
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Engine

from ..db import DbHandle, get_db

# Estimated transcription rates in USD per hour of audio, from public rate
# cards (Oct 2026): AssemblyAI universal-3-5-pro batch $0.21/hr + standard
# speaker diarization add-on $0.02/hr; Speechmatics Standard batch
# pay-as-you-go $0.45/hr; Muse Voice Transcribe $0.18/hr. Local transcription
# runs on-device and is free.
TRANSCRIPTION_USD_PER_HOUR: dict[str, float] = {
    "assemblyai": 0.23,
    "muse": 0.18,
    "speechmatics": 0.45,
    "local": 0.0,
}

BACKFILL_MARKER = "usage_backfill_v1"

CREATE_USAGE_EVENTS_SQL = """CREATE TABLE IF NOT EXISTS usage_events (
    id TEXT PRIMARY KEY,
    meeting_id TEXT REFERENCES meetings(id),
    kind TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    audio_seconds REAL,
    cost_usd REAL,
    source TEXT NOT NULL UNIQUE,
    detail TEXT,
    created_at INTEGER NOT NULL
)"""

CREATE_USAGE_EVENTS_INDEX_SQL = [
    "CREATE INDEX IF NOT EXISTS idx_usage_events_created ON usage_events(created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_usage_events_meeting ON usage_events(meeting_id)",
]

_MONTH_RE = re.compile(r"^(\d{4})-(\d{2})$")


def _engine_of(db: Engine | DbHandle | None) -> Engine:
    if isinstance(db, DbHandle):
        return db.engine
    if isinstance(db, Engine):
        return db
    return get_db()


def ensure_usage_table(db: Engine | DbHandle | None = None) -> None:
    """Creates ``usage_events`` (and indexes) when missing.

    Defensive ``IF NOT EXISTS`` DDL so usage recording never fails, even for
    databases created by older code or hand-built test schemas.
    """
    engine = _engine_of(db)
    with engine.begin() as conn:
        conn.execute(text(CREATE_USAGE_EVENTS_SQL))
        for stmt in CREATE_USAGE_EVENTS_INDEX_SQL:
            conn.execute(text(stmt))


def month_bounds_ms(month: str) -> tuple[int, int]:
    """Returns ``(start_ms, end_ms_exclusive)`` UTC epoch-ms for ``YYYY-MM``."""
    from calendar import monthrange
    from datetime import datetime

    m = _MONTH_RE.match(month.strip())
    if not m:
        raise ValueError(f"Invalid month '{month}'; expected YYYY-MM")
    year, mon = int(m.group(1)), int(m.group(2))
    if not 1 <= mon <= 12:
        raise ValueError(f"Invalid month '{month}'; expected YYYY-MM")
    start = datetime(year, mon, 1, tzinfo=UTC)
    days = monthrange(year, mon)[1]
    end = datetime(year, mon, days, 23, 59, 59, 999000, tzinfo=UTC)
    return int(start.timestamp() * 1000), int(end.timestamp() * 1000) + 1


def current_month_str(now_ms: int | None = None) -> str:
    from datetime import datetime

    dt = datetime.fromtimestamp((now_ms if now_ms is not None else int(time.time() * 1000)) / 1000, tz=UTC)
    return f"{dt.year:04d}-{dt.month:02d}"


def estimate_llm_cost(
    provider: str | None,
    model: str | None,
    input_tokens: int,
    output_tokens: int,
) -> float | None:
    """Estimates LLM cost in USD from catalog per-1M-token rates.

    Returns ``None`` when the model is unknown so callers can distinguish
    "unknown price" from "free".
    """
    if not provider or not model or (not input_tokens and not output_tokens):
        return None
    try:
        from .llm import BUILTIN_CATALOG
    except Exception:
        return None
    prov = provider.strip().lower()
    mid = model.strip()
    for entry in BUILTIN_CATALOG:
        if not isinstance(entry, dict):
            continue
        if str(entry.get("provider", "")).lower() != prov:
            continue
        if str(entry.get("id", "")) != mid:
            continue
        cost = entry.get("cost")
        if not isinstance(cost, dict):
            return None
        try:
            in_rate = float(cost.get("input") or 0)
            out_rate = float(cost.get("output") or 0)
        except (TypeError, ValueError):
            return None
        return round(input_tokens / 1_000_000 * in_rate + output_tokens / 1_000_000 * out_rate, 6)
    return None


def estimate_transcription_cost(provider: str | None, audio_seconds: float | None) -> float | None:
    """Estimates transcription cost in USD from per-hour rates."""
    if audio_seconds is None or audio_seconds < 0:
        return None
    rate = TRANSCRIPTION_USD_PER_HOUR.get((provider or "").strip().lower())
    if rate is None:
        return None
    return round(audio_seconds / 3600 * rate, 6)


def record_llm_usage(
    db: Engine | DbHandle | None,
    *,
    meeting_id: str | None,
    kind: str,
    provider: str,
    model: str | None,
    input_tokens: int = 0,
    output_tokens: int = 0,
    total_tokens: int = 0,
    created_at: int | None = None,
    source: str | None = None,
    detail: dict[str, Any] | None = None,
) -> str:
    """Inserts an LLM usage event; idempotent per ``source`` key."""
    ensure_usage_table(db)
    engine = _engine_of(db)
    now = created_at if created_at is not None else int(time.time() * 1000)
    total = total_tokens or (input_tokens + output_tokens)
    cost = estimate_llm_cost(provider, model, input_tokens, output_tokens)
    event_id = str(uuid.uuid4())
    with engine.begin() as conn:
        conn.execute(
            text(
                """
                INSERT INTO usage_events (
                  id, meeting_id, kind, provider, model,
                  input_tokens, output_tokens, total_tokens,
                  audio_seconds, cost_usd, source, detail, created_at
                ) VALUES (
                  :id, :mid, :kind, :provider, :model,
                  :in_tok, :out_tok, :tot_tok,
                  NULL, :cost, :source, :detail, :now
                )
                ON CONFLICT(source) DO NOTHING
                """
            ),
            {
                "id": event_id,
                "mid": meeting_id,
                "kind": kind,
                "provider": provider,
                "model": model,
                "in_tok": int(input_tokens),
                "out_tok": int(output_tokens),
                "tot_tok": int(total),
                "cost": cost,
                "source": source or f"llm:{event_id}",
                "detail": json.dumps(detail) if detail is not None else None,
                "now": now,
            },
        )
    return event_id


def _resolve_audio_seconds(
    conn: Any,
    recording_id: str | None,
    meeting_id: str | None,
    content: str | None = None,
) -> float | None:
    if recording_id:
        try:
            row = (
                conn.execute(
                    text("SELECT duration_ms FROM recordings WHERE id = :id"),
                    {"id": recording_id},
                )
                .mappings()
                .first()
            )
        except Exception:
            row = None
        if row is not None and row.get("duration_ms"):
            return float(row["duration_ms"]) / 1000.0
    if content:
        try:
            parsed = json.loads(content)
            dur = parsed.get("durationMs") if isinstance(parsed, dict) else None
            if dur:
                return float(dur) / 1000.0
        except Exception:
            pass
    if meeting_id:
        try:
            row = (
                conn.execute(
                    text("SELECT start_time, end_time FROM meetings WHERE id = :id"),
                    {"id": meeting_id},
                )
                .mappings()
                .first()
            )
        except Exception:
            row = None
        if row is not None and row.get("end_time") and row.get("start_time"):
            span = (int(row["end_time"]) - int(row["start_time"])) / 1000.0
            if span > 0:
                return span
    return None


def record_transcription_usage(
    db: Engine | DbHandle | None,
    *,
    meeting_id: str | None,
    provider: str,
    recording_id: str | None = None,
    audio_seconds: float | None = None,
    transcript_content: str | None = None,
    created_at: int | None = None,
    source: str | None = None,
    detail: dict[str, Any] | None = None,
) -> str:
    """Inserts a transcription usage event; idempotent per ``source`` key."""
    ensure_usage_table(db)
    engine = _engine_of(db)
    now = created_at if created_at is not None else int(time.time() * 1000)
    event_id = str(uuid.uuid4())
    with engine.begin() as conn:
        seconds = audio_seconds
        if seconds is None:
            seconds = _resolve_audio_seconds(conn, recording_id, meeting_id, transcript_content)
        cost = estimate_transcription_cost(provider, seconds)
        conn.execute(
            text(
                """
                INSERT INTO usage_events (
                  id, meeting_id, kind, provider, model,
                  input_tokens, output_tokens, total_tokens,
                  audio_seconds, cost_usd, source, detail, created_at
                ) VALUES (
                  :id, :mid, 'transcription', :provider, NULL,
                  0, 0, 0,
                  :seconds, :cost, :source, :detail, :now
                )
                ON CONFLICT(source) DO NOTHING
                """
            ),
            {
                "id": event_id,
                "mid": meeting_id,
                "provider": provider,
                "seconds": seconds,
                "cost": cost,
                "source": source or f"transcription:{event_id}",
                "detail": json.dumps(detail) if detail is not None else None,
                "now": now,
            },
        )
    return event_id


def backfill_usage_events(db: Engine | DbHandle | None = None) -> dict[str, int]:
    """One-time backfill of usage events from pre-existing rows.

    Covers assistant chat messages (token usage is stored on the row) and
    transcript artifacts (cost derived from audio duration). Summary
    generations never persisted token counts, so history starts at deploy
    time for those. Guarded by a ``sync_state`` marker; safe to call often.
    """
    ensure_usage_table(db)
    engine = _engine_of(db)
    with engine.begin() as conn:
        marker = conn.execute(
            text("SELECT value FROM sync_state WHERE key = :k"),
            {"k": BACKFILL_MARKER},
        ).first()
        if marker is not None:
            return {"chat": 0, "transcription": 0, "skipped": True}  # type: ignore[dict-item]
        chat_count = 0
        tx_count = 0
        try:
            chat_rows = (
                conn.execute(
                    text(
                        "SELECT id, meeting_id, provider, model, usage, created_at "
                        "FROM chat_messages WHERE role = 'assistant'"
                    )
                )
                .mappings()
                .all()
            )
        except Exception:
            chat_rows = []
        for row in chat_rows:
            try:
                usage = json.loads(row["usage"]) if row.get("usage") else {}
            except Exception:
                usage = {}
            if not isinstance(usage, dict):
                usage = {}
            in_tok = int(usage.get("inputTokens") or usage.get("input_tokens") or 0)
            out_tok = int(usage.get("outputTokens") or usage.get("output_tokens") or 0)
            tot_tok = int(usage.get("totalTokens") or usage.get("total_tokens") or (in_tok + out_tok))
            cost = usage.get("cost")
            if cost is None:
                cost = estimate_llm_cost(row.get("provider"), row.get("model"), in_tok, out_tok)
            try:
                cost_val = float(cost) if cost is not None else None
            except (TypeError, ValueError):
                cost_val = None
            res = conn.execute(
                text(
                    """
                    INSERT INTO usage_events (
                      id, meeting_id, kind, provider, model,
                      input_tokens, output_tokens, total_tokens,
                      audio_seconds, cost_usd, source, detail, created_at
                    ) VALUES (
                      :id, :mid, 'chat', :provider, :model,
                      :in_tok, :out_tok, :tot_tok,
                      NULL, :cost, :source, NULL, :now
                    )
                    ON CONFLICT(source) DO NOTHING
                    """
                ),
                {
                    "id": str(uuid.uuid4()),
                    "mid": row.get("meeting_id"),
                    "provider": row.get("provider") or "unknown",
                    "model": row.get("model"),
                    "in_tok": in_tok,
                    "out_tok": out_tok,
                    "tot_tok": tot_tok,
                    "cost": cost_val,
                    "source": f"chat:{row['id']}",
                    "now": int(row.get("created_at") or 0),
                },
            )
            chat_count += res.rowcount or 0
        try:
            artifact_rows = (
                conn.execute(
                    text(
                        """
                        SELECT a.id AS aid, a.meeting_id AS mid, a.provider AS prov,
                               a.recording_id AS rid, a.created_at AS created_at,
                               r.duration_ms AS duration_ms,
                               m.start_time AS start_time, m.end_time AS end_time
                        FROM artifacts a
                        LEFT JOIN recordings r ON r.id = a.recording_id
                        LEFT JOIN meetings m ON m.id = a.meeting_id
                        WHERE a.kind = 'transcript' AND a.format = 'json'
                        """
                    )
                )
                .mappings()
                .all()
            )
        except Exception:
            artifact_rows = []
        for row in artifact_rows:
            seconds: float | None = None
            if row.get("duration_ms"):
                seconds = float(row["duration_ms"]) / 1000.0
            elif row.get("end_time") and row.get("start_time"):
                span = (int(row["end_time"]) - int(row["start_time"])) / 1000.0
                seconds = span if span > 0 else None
            cost = estimate_transcription_cost(row.get("prov"), seconds)
            res = conn.execute(
                text(
                    """
                    INSERT INTO usage_events (
                      id, meeting_id, kind, provider, model,
                      input_tokens, output_tokens, total_tokens,
                      audio_seconds, cost_usd, source, detail, created_at
                    ) VALUES (
                      :id, :mid, 'transcription', :provider, NULL,
                      0, 0, 0,
                      :seconds, :cost, :source, :detail, :now
                    )
                    ON CONFLICT(source) DO NOTHING
                    """
                ),
                {
                    "id": str(uuid.uuid4()),
                    "mid": row.get("mid"),
                    "provider": row.get("prov") or "unknown",
                    "seconds": seconds,
                    "cost": cost,
                    "source": f"transcript:{row['aid']}",
                    "detail": json.dumps({"artifactId": row["aid"]}),
                    "now": int(row.get("created_at") or 0),
                },
            )
            tx_count += res.rowcount or 0
        conn.execute(
            text(
                "INSERT INTO sync_state (key, value) VALUES (:k, :v) ON CONFLICT(key) DO UPDATE SET value = :v"
            ),
            {"k": BACKFILL_MARKER, "v": json.dumps({"at": int(time.time() * 1000)})},
        )
    return {"chat": chat_count, "transcription": tx_count, "skipped": False}  # type: ignore[dict-item]


def _row_to_event(row: Any) -> dict[str, Any]:
    return {
        "id": row["id"],
        "meetingId": row.get("meeting_id"),
        "meetingTitle": row.get("meeting_title"),
        "kind": row.get("kind"),
        "provider": row.get("provider"),
        "model": row.get("model"),
        "inputTokens": int(row.get("input_tokens") or 0),
        "outputTokens": int(row.get("output_tokens") or 0),
        "totalTokens": int(row.get("total_tokens") or 0),
        "audioSeconds": float(row["audio_seconds"]) if row.get("audio_seconds") is not None else None,
        "costUsd": float(row["cost_usd"]) if row.get("cost_usd") is not None else None,
        "createdAt": int(row.get("created_at") or 0),
    }


def get_usage_summary(
    db: Engine | DbHandle | None = None,
    *,
    start_ms: int | None = None,
    end_ms: int | None = None,
    include_rates: bool = True,
) -> dict[str, Any]:
    """Aggregates usage events into totals plus by-provider/per-meeting splits."""
    backfill_usage_events(db)
    engine = _engine_of(db)
    clauses = []
    params: dict[str, Any] = {}
    if start_ms is not None:
        clauses.append("u.created_at >= :start_ms")
        params["start_ms"] = start_ms
    if end_ms is not None:
        clauses.append("u.created_at < :end_ms")
        params["end_ms"] = end_ms
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with engine.connect() as conn:
        rows = (
            conn.execute(
                text(
                    f"""
                    SELECT u.*, m.title AS meeting_title, m.start_time AS meeting_start
                    FROM usage_events u
                    LEFT JOIN meetings m ON m.id = u.meeting_id
                    {where}
                    ORDER BY u.created_at ASC
                    """
                ),
                params,
            )
            .mappings()
            .all()
        )
    audio_seconds = 0.0
    tx_cost = 0.0
    in_tok = 0
    out_tok = 0
    llm_cost = 0.0
    providers: dict[str, dict[str, Any]] = {}
    meetings: dict[str, dict[str, Any]] = {}
    for row in rows:
        kind = str(row.get("kind") or "")
        provider = str(row.get("provider") or "unknown")
        seconds = float(row["audio_seconds"]) if row.get("audio_seconds") is not None else 0.0
        cost = float(row["cost_usd"]) if row.get("cost_usd") is not None else 0.0
        it = int(row.get("input_tokens") or 0)
        ot = int(row.get("output_tokens") or 0)
        if kind == "transcription":
            audio_seconds += seconds
            tx_cost += cost
        else:
            in_tok += it
            out_tok += ot
            llm_cost += cost
        p = providers.setdefault(
            provider,
            {
                "provider": provider,
                "kinds": set(),
                "audioSeconds": 0.0,
                "inputTokens": 0,
                "outputTokens": 0,
                "totalTokens": 0,
                "eventCount": 0,
                "costUsd": 0.0,
            },
        )
        p["kinds"].add(kind)
        p["audioSeconds"] += seconds
        p["inputTokens"] += it
        p["outputTokens"] += ot
        p["totalTokens"] += it + ot
        p["eventCount"] += 1
        p["costUsd"] += cost
        mid = row.get("meeting_id") or "__none__"
        mb = meetings.setdefault(
            mid,
            {
                "meetingId": row.get("meeting_id"),
                "meetingTitle": row.get("meeting_title"),
                "meetingStartTime": int(row["meeting_start"])
                if row.get("meeting_start") is not None
                else None,
                "audioSeconds": 0.0,
                "transcriptionCostUsd": 0.0,
                "inputTokens": 0,
                "outputTokens": 0,
                "totalTokens": 0,
                "llmCostUsd": 0.0,
                "totalCostUsd": 0.0,
                "eventCount": 0,
            },
        )
        if kind == "transcription":
            mb["audioSeconds"] += seconds
            mb["transcriptionCostUsd"] += cost
        else:
            mb["inputTokens"] += it
            mb["outputTokens"] += ot
            mb["llmCostUsd"] += cost
        mb["totalTokens"] = mb["inputTokens"] + mb["outputTokens"]
        mb["totalCostUsd"] = mb["transcriptionCostUsd"] + mb["llmCostUsd"]
        mb["eventCount"] += 1
    by_provider = [
        {
            "provider": v["provider"],
            "kinds": sorted(v["kinds"]),
            "audioSeconds": round(v["audioSeconds"], 1),
            "inputTokens": v["inputTokens"],
            "outputTokens": v["outputTokens"],
            "totalTokens": v["totalTokens"],
            "eventCount": v["eventCount"],
            "costUsd": round(v["costUsd"], 6),
        }
        for v in sorted(providers.values(), key=lambda v: v["costUsd"], reverse=True)
    ]
    by_meeting = [
        {
            "meetingId": v["meetingId"],
            "meetingTitle": v["meetingTitle"],
            "meetingStartTime": v["meetingStartTime"],
            "audioSeconds": round(v["audioSeconds"], 1),
            "transcriptionCostUsd": round(v["transcriptionCostUsd"], 6),
            "inputTokens": v["inputTokens"],
            "outputTokens": v["outputTokens"],
            "totalTokens": v["totalTokens"],
            "llmCostUsd": round(v["llmCostUsd"], 6),
            "totalCostUsd": round(v["totalCostUsd"], 6),
            "eventCount": v["eventCount"],
        }
        for v in sorted(meetings.values(), key=lambda v: v["totalCostUsd"], reverse=True)
        if v["meetingId"] is not None
    ]
    summary: dict[str, Any] = {
        "startAt": start_ms,
        "endAt": end_ms,
        "audioSeconds": round(audio_seconds, 1),
        "transcriptionCostUsd": round(tx_cost, 6),
        "inputTokens": in_tok,
        "outputTokens": out_tok,
        "totalTokens": in_tok + out_tok,
        "llmCostUsd": round(llm_cost, 6),
        "totalCostUsd": round(tx_cost + llm_cost, 6),
        "eventCount": len(rows),
        "byProvider": by_provider,
        "byMeeting": by_meeting,
    }
    if include_rates:
        summary["rates"] = {
            "transcriptionUsdPerHour": dict(TRANSCRIPTION_USD_PER_HOUR),
            "llmUsdPerMTokensNote": "Per-model input/output rates per 1M tokens from the LLM catalog.",
        }
    return summary


def get_meeting_usage(
    db: Engine | DbHandle | None = None,
    meeting_id: str = "",
    *,
    limit: int = 100,
) -> dict[str, Any]:
    """Totals plus recent events for a single meeting."""
    backfill_usage_events(db)
    engine = _engine_of(db)
    with engine.connect() as conn:
        rows = (
            conn.execute(
                text(
                    """
                    SELECT u.*, m.title AS meeting_title
                    FROM usage_events u
                    LEFT JOIN meetings m ON m.id = u.meeting_id
                    WHERE u.meeting_id = :mid
                    ORDER BY u.created_at DESC
                    LIMIT :lim
                    """
                ),
                {"mid": meeting_id, "lim": max(1, limit)},
            )
            .mappings()
            .all()
        )
        totals = (
            conn.execute(
                text(
                    """
                    SELECT
                      COALESCE(SUM(CASE WHEN kind = 'transcription' THEN audio_seconds ELSE 0 END), 0) AS audio_s,
                      COALESCE(SUM(CASE WHEN kind = 'transcription' THEN cost_usd ELSE 0 END), 0) AS tx_cost,
                      COALESCE(SUM(CASE WHEN kind != 'transcription' THEN input_tokens ELSE 0 END), 0) AS in_tok,
                      COALESCE(SUM(CASE WHEN kind != 'transcription' THEN output_tokens ELSE 0 END), 0) AS out_tok,
                      COALESCE(SUM(CASE WHEN kind != 'transcription' THEN cost_usd ELSE 0 END), 0) AS llm_cost,
                      COUNT(*) AS n
                    FROM usage_events WHERE meeting_id = :mid
                    """
                ),
                {"mid": meeting_id},
            )
            .mappings()
            .first()
        )
    totals = totals or {}
    audio_s = float(totals.get("audio_s") or 0)
    tx_cost = float(totals.get("tx_cost") or 0)
    in_tok = int(totals.get("in_tok") or 0)
    out_tok = int(totals.get("out_tok") or 0)
    llm_cost = float(totals.get("llm_cost") or 0)
    return {
        "meetingId": meeting_id,
        "audioSeconds": round(audio_s, 1),
        "transcriptionCostUsd": round(tx_cost, 6),
        "inputTokens": in_tok,
        "outputTokens": out_tok,
        "totalTokens": in_tok + out_tok,
        "llmCostUsd": round(llm_cost, 6),
        "totalCostUsd": round(tx_cost + llm_cost, 6),
        "eventCount": int(totals.get("n") or 0),
        "events": [_row_to_event(r) for r in rows],
    }
