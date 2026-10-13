"""Structured JSON console & SQLite logger (port of packages/server/src/logger.ts)."""

from __future__ import annotations

import json
import sqlite3
import sys
import time
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from sqlalchemy.engine import Engine

from .db.session import DbHandle, get_db_handle
from .schemas import LogLevel

_active_log_target: DbHandle | Engine | sqlite3.Connection | None = None
_external_log_sink: Callable[[LogLevel, str, dict[str, Any]], None] | None = None


def set_log_database(target: DbHandle | Engine | sqlite3.Connection | None) -> None:
    global _active_log_target
    _active_log_target = target


def set_log_sink(
    sink: Callable[[LogLevel, str, dict[str, Any]], None] | None,
) -> None:
    """Optional sink used by worker subprocesses to forward logs to the parent process."""
    global _external_log_sink
    _external_log_sink = sink


def _insert_log_row(
    log_id: str,
    level: str,
    category: str,
    message: str,
    meeting_id: str | None,
    details_json: str | None,
    created_at: int,
) -> None:
    target = _active_log_target
    if target is None:
        try:
            target = get_db_handle()
        except Exception:
            return

    sql = """
        INSERT INTO logs (id, level, category, message, meeting_id, details, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    """
    params = (log_id, level, category, message, meeting_id, details_json, created_at)

    if isinstance(target, sqlite3.Connection):
        target.execute(sql, params)
        target.commit()
        return

    engine = target.engine if isinstance(target, DbHandle) else target
    raw = engine.raw_connection()
    try:
        conn: sqlite3.Connection = raw.driver_connection  # type: ignore[assignment]
        conn.execute(sql, params)
        raw.commit()
    finally:
        raw.close()


class Logger:
    def _write(self, level: LogLevel, message: str, fields: dict[str, Any] | None = None) -> None:
        if _external_log_sink is not None:
            try:
                _external_log_sink(level, message, dict(fields or {}))
                return
            except Exception:
                pass

        now = int(time.time() * 1000)
        ts = datetime.fromtimestamp(now / 1000.0, tz=UTC).isoformat().replace("+00:00", "Z")
        extra = dict(fields or {})
        category = str(extra.pop("category", "system"))
        meeting_id = extra.pop("meetingId", extra.pop("meeting_id", None))
        extra.pop("meeting_id", None)

        payload: dict[str, Any] = {
            "timestamp": ts,
            "level": level,
            "category": category,
            "message": message,
        }
        if meeting_id is not None:
            payload["meetingId"] = str(meeting_id)
        for k, v in extra.items():
            try:
                json.dumps(v)
                payload[k] = v
            except TypeError:
                payload[k] = str(v)

        line = json.dumps(payload)
        stream = sys.stderr if level in ("error", "warn") else sys.stdout
        print(line, file=stream, flush=True)

        try:
            details_dict = {k: payload[k] for k in extra.keys() if k in payload}
            details_json = json.dumps(details_dict) if details_dict else None
            _insert_log_row(
                log_id=str(uuid.uuid4()),
                level=level,
                category=category,
                message=message,
                meeting_id=str(meeting_id) if meeting_id else None,
                details_json=details_json,
                created_at=now,
            )
        except Exception:
            # Non-blocking: database logging errors must never disrupt business operations
            pass

    def debug(self, message: str, fields: dict[str, Any] | None = None, **kwargs: Any) -> None:
        merged = {**(fields or {}), **kwargs}
        self._write("debug", message, merged)

    def info(self, message: str, fields: dict[str, Any] | None = None, **kwargs: Any) -> None:
        merged = {**(fields or {}), **kwargs}
        self._write("info", message, merged)

    def warn(self, message: str, fields: dict[str, Any] | None = None, **kwargs: Any) -> None:
        merged = {**(fields or {}), **kwargs}
        self._write("warn", message, merged)

    def error(self, message: str, fields: dict[str, Any] | None = None, **kwargs: Any) -> None:
        merged = {**(fields or {}), **kwargs}
        self._write("error", message, merged)


logger = Logger()
