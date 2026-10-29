"""Backup and restore pipeline tests (port of backup.test.ts)."""

from __future__ import annotations

import json
import shutil
import tarfile
from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy import text

from olive.app import create_app
from olive.db import create_db, set_db_for_tests
from olive.layout import meeting_paths
from olive.services.backup import BackupService

SAMPLE_AUDIO = b"RIFF....WAVEfmt ....dataFAKEAUDIOBYTES12345"


def _setup_backup_env(tmp_path: Path):
    config_dir = tmp_path / "config"
    meetings_dir = tmp_path / "meetings"
    backups_dir = tmp_path / "backups"
    database_path = config_dir / "olive.sqlite"
    settings_path = config_dir / "settings.json"

    config_dir.mkdir(parents=True, exist_ok=True)
    meetings_dir.mkdir(parents=True, exist_ok=True)
    backups_dir.mkdir(parents=True, exist_ok=True)

    handle = create_db(str(database_path))
    set_db_for_tests(handle)
    return (
        handle,
        str(config_dir),
        str(meetings_dir),
        str(backups_dir),
        str(database_path),
        str(settings_path),
    )


async def test_creates_backup_archive_containing_sqlite_db_settings_and_audio_files(
    tmp_path: Path,
) -> None:
    handle, config_dir, meetings_dir, backups_dir, database_path, settings_path = (
        _setup_backup_env(tmp_path)
    )
    meeting_id = "11111111-1111-4111-8111-111111111111"
    recording_id = "22222222-2222-4222-8222-222222222222"
    speaker_id = "33333333-3333-4333-8333-333333333333"
    now = 1_700_000_000_000

    with handle.engine.begin() as conn:
        conn.execute(
            text(
                """
                INSERT INTO meetings (
                  id, title, start_time, end_time, source, status, tags,
                  primary_transcript_artifact_id, primary_summary_artifact_id,
                  last_error, created_at, updated_at
                ) VALUES (
                  :id, 'Architecture Planning', :now, :end, 'upload', 'ready', '["arch","q3"]',
                  NULL, NULL, NULL, :now, :now
                )
                """
            ),
            {"id": meeting_id, "now": now, "end": now + 3_600_000},
        )
        conn.execute(
            text(
                """
                INSERT INTO recordings (
                  id, meeting_id, path, mime, duration_ms, size_bytes, sha256,
                  provider, provider_recording_id, created_at
                ) VALUES (
                  :rid, :mid, 'audio/sample.wav', 'audio/wav', 120000, :sz,
                  'fake-sha-256', 'upload', NULL, :now
                )
                """
            ),
            {"rid": recording_id, "mid": meeting_id, "sz": len(SAMPLE_AUDIO), "now": now},
        )
        conn.execute(
            text(
                """
                INSERT INTO speakers (
                  id, name, provider_ids, enrolled_at, enrollment_clip_paths, created_at
                ) VALUES (
                  :sid, 'Alice Engineer', '{}', :now, '[]', :now
                )
                """
            ),
            {"sid": speaker_id, "now": now},
        )

    paths = meeting_paths(meetings_dir, now, "Architecture Planning", meeting_id)
    Path(paths.audio_dir).mkdir(parents=True, exist_ok=True)
    Path(paths.summaries_dir).mkdir(parents=True, exist_ok=True)
    Path(paths.transcripts_dir).mkdir(parents=True, exist_ok=True)

    (Path(paths.audio_dir) / "sample.wav").write_bytes(SAMPLE_AUDIO)
    (Path(paths.summaries_dir) / "summary_1700000000000_note1.md").write_text(
        "# Architecture Summary\nKey points discussed.", encoding="utf-8"
    )
    (Path(paths.transcripts_dir) / "transcript.json").write_text(
        json.dumps({"segments": []}), encoding="utf-8"
    )
    Path(settings_path).write_text(
        json.dumps({"defaultProvider": "google", "defaultModel": "gemini-2.5-flash"}),
        encoding="utf-8",
    )

    backup_service = BackupService(
        {
            "db": handle.engine,
            "configDir": config_dir,
            "meetingsDir": meetings_dir,
            "backupsDir": backups_dir,
            "databasePath": database_path,
            "settingsPath": settings_path,
        }
    )

    result = await backup_service.create_backup()
    assert Path(result["path"]).exists()
    assert result["sizeBytes"] > 100
    stats = result["manifest"]["stats"]
    assert stats["meetingCount"] == 1
    assert stats["recordingCount"] == 1
    assert stats["audioFilesCount"] == 1
    assert stats["totalAudioSizeBytes"] == len(SAMPLE_AUDIO)
    assert stats["speakerCount"] == 1
    assert stats["summaryCount"] == 1

    listed = await backup_service.list_backups()
    assert len(listed) == 1
    assert listed[0]["filename"] == result["filename"]
    assert listed[0]["manifest"]["stats"]["meetingCount"] == 1

    set_db_for_tests(None)


async def test_restores_database_settings_and_audio_files_from_backup_archive(
    tmp_path: Path,
) -> None:
    handle, config_dir, meetings_dir, backups_dir, database_path, settings_path = (
        _setup_backup_env(tmp_path)
    )
    meeting_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    recording_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    now = 1_700_000_000_000

    with handle.engine.begin() as conn:
        conn.execute(
            text(
                """
                INSERT INTO meetings (
                  id, title, start_time, end_time, source, status, tags,
                  primary_transcript_artifact_id, primary_summary_artifact_id,
                  last_error, created_at, updated_at
                ) VALUES (
                  :id, 'Sprint Review', :now, :end, 'upload', 'ready', '[]',
                  NULL, NULL, NULL, :now, :now
                )
                """
            ),
            {"id": meeting_id, "now": now, "end": now + 1_800_000},
        )
        conn.execute(
            text(
                """
                INSERT INTO recordings (
                  id, meeting_id, path, mime, duration_ms, size_bytes, sha256,
                  provider, provider_recording_id, created_at
                ) VALUES (
                  :rid, :mid, 'audio/sprint.wav', 'audio/wav', 60000, :sz,
                  'fake-sha', 'upload', NULL, :now
                )
                """
            ),
            {"rid": recording_id, "mid": meeting_id, "sz": len(SAMPLE_AUDIO), "now": now},
        )

    m_paths = meeting_paths(meetings_dir, now, "Sprint Review", meeting_id)
    Path(m_paths.audio_dir).mkdir(parents=True, exist_ok=True)
    Path(m_paths.summaries_dir).mkdir(parents=True, exist_ok=True)
    (Path(m_paths.audio_dir) / "sprint.wav").write_bytes(SAMPLE_AUDIO)
    (Path(m_paths.summaries_dir) / "summary_1_sprint.md").write_text(
        "# Sprint Review Note", encoding="utf-8"
    )
    Path(settings_path).write_text(json.dumps({"defaultProvider": "anthropic"}), encoding="utf-8")
    chatgpt_tokens = Path(config_dir) / "chatgpt-plan-tokens.json"
    chatgpt_tokens.write_text(json.dumps({"clientId": "oaiapp_backup"}), encoding="utf-8")

    backup_service = BackupService(
        {
            "db": handle.engine,
            "configDir": config_dir,
            "meetingsDir": meetings_dir,
            "backupsDir": backups_dir,
            "databasePath": database_path,
            "settingsPath": settings_path,
        }
    )

    backup_result = await backup_service.create_backup({"filename": "sprint-backup.tar.gz"})

    # Wipe current state
    shutil.rmtree(meetings_dir, ignore_errors=True)
    Path(meetings_dir).mkdir(parents=True, exist_ok=True)
    Path(settings_path).write_text(json.dumps({"defaultProvider": "wiped"}), encoding="utf-8")
    chatgpt_tokens.unlink()

    restore_result = await backup_service.restore_backup(backup_result["path"])
    assert restore_result["success"] is True
    assert restore_result["stats"]["meetings"] == 1
    assert restore_result["stats"]["recordings"] == 1
    assert restore_result["stats"]["audioFiles"] == 1

    restored_audio = Path(m_paths.audio_dir) / "sprint.wav"
    assert restored_audio.exists()
    assert restored_audio.read_bytes() == SAMPLE_AUDIO

    restored_summary = Path(m_paths.summaries_dir) / "summary_1_sprint.md"
    assert restored_summary.exists()

    restored_settings = json.loads(Path(settings_path).read_text(encoding="utf-8"))
    assert restored_settings["defaultProvider"] == "anthropic"
    assert json.loads(chatgpt_tokens.read_text(encoding="utf-8")) == {"clientId": "oaiapp_backup"}

    # Also test legacy backup layout (database/olive.sqlite + backup_manifest.json)
    legacy_staging = tmp_path / "legacy-staging"
    (legacy_staging / "database").mkdir(parents=True, exist_ok=True)
    shutil.copy2(database_path, legacy_staging / "database" / "olive.sqlite")
    (legacy_staging / "backup_manifest.json").write_text(
        json.dumps(backup_result["manifest"]), encoding="utf-8"
    )
    legacy_tar = tmp_path / "legacy-backup.tar.gz"
    with tarfile.open(legacy_tar, "w:gz") as tar:
        for item in legacy_staging.iterdir():
            tar.add(item, arcname=item.name)

    legacy_restore = await backup_service.restore_backup(str(legacy_tar))
    assert legacy_restore["success"] is True
    assert legacy_restore["stats"]["meetings"] == 1

    set_db_for_tests(None)


def test_backup_rest_api_endpoints(tmp_path: Path) -> None:
    handle, config_dir, meetings_dir, backups_dir, database_path, settings_path = (
        _setup_backup_env(tmp_path)
    )
    meeting_id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
    now = 1_700_000_000_000

    with handle.engine.begin() as conn:
        conn.execute(
            text(
                """
                INSERT INTO meetings (
                  id, title, start_time, end_time, source, status, tags,
                  primary_transcript_artifact_id, primary_summary_artifact_id,
                  last_error, created_at, updated_at
                ) VALUES (
                  :id, 'API Meeting', :now, :end, 'upload', 'ready', '[]',
                  NULL, NULL, NULL, :now, :now
                )
                """
            ),
            {"id": meeting_id, "now": now, "end": now + 3_600_000},
        )

    m_paths = meeting_paths(meetings_dir, now, "API Meeting", meeting_id)
    Path(m_paths.audio_dir).mkdir(parents=True, exist_ok=True)
    (Path(m_paths.audio_dir) / "recording.wav").write_bytes(SAMPLE_AUDIO)

    backup_service = BackupService(
        {
            "db": handle.engine,
            "configDir": config_dir,
            "meetingsDir": meetings_dir,
            "backupsDir": backups_dir,
            "databasePath": database_path,
            "settingsPath": settings_path,
        }
    )
    app = create_app(
        {
            "db": handle.engine,
            "configDir": config_dir,
            "meetingsDir": meetings_dir,
            "backupsDir": backups_dir,
            "backupService": backup_service,
        }
    )
    client = TestClient(app)

    create_res = client.post("/api/backup", json={"filename": "api-test-backup.tar.gz"})
    assert create_res.status_code == 201
    create_data = create_res.json()
    assert create_data["ok"] is True
    assert create_data["backup"]["filename"] == "api-test-backup.tar.gz"
    assert create_data["backup"]["manifest"]["stats"]["meetingCount"] == 1
    assert create_data["backup"]["manifest"]["stats"]["audioFilesCount"] == 1

    list_res = client.get("/api/backup/list")
    assert list_res.status_code == 200
    list_data = list_res.json()
    assert list_data["ok"] is True
    assert len(list_data["backups"]) == 1
    assert list_data["backups"][0]["filename"] == "api-test-backup.tar.gz"

    download_res = client.get("/api/backup/download/api-test-backup.tar.gz")
    assert download_res.status_code == 200
    assert download_res.headers["content-type"] == "application/gzip"
    downloaded_bytes = download_res.content
    assert len(downloaded_bytes) > 100

    export_res = client.get("/api/backup/export")
    assert export_res.status_code == 200
    assert export_res.headers["content-type"] == "application/gzip"
    assert len(export_res.content) > 100

    restore_res = client.post(
        "/api/backup/restore",
        files={"file": ("upload-backup.tar.gz", downloaded_bytes, "application/gzip")},
    )
    assert restore_res.status_code == 200
    restore_data = restore_res.json()
    assert restore_data["ok"] is True
    assert restore_data["result"]["stats"]["meetings"] == 1
    assert restore_data["result"]["stats"]["audioFiles"] == 1

    del_res = client.delete("/api/backup/api-test-backup.tar.gz")
    assert del_res.status_code == 200
    assert del_res.json()["ok"] is True

    after_del = client.get("/api/backup/list").json()
    assert not any(b["filename"] == "api-test-backup.tar.gz" for b in after_del["backups"])

    set_db_for_tests(None)
