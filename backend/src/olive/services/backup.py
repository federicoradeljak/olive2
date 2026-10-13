"""Complete system backup (.tar.gz) and disaster recovery service (port of backup/service.ts)."""

from __future__ import annotations

import json
import shutil
import sqlite3
import tarfile
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy.engine import Engine

from ..db import DbHandle, close_db, get_db, reset_db_handle
from ..logging_db import Logger
from ..logging_db import logger as default_logger
from ..schemas import BackupInfo, BackupManifest, BackupManifestStats, RestoreResult, RestoreStats
from ..settings import OlivePaths, clear_app_config_cache, resolve_paths


class BackupService:
    def __init__(
        self,
        options: dict[str, Any] | None = None,
        *,
        db: Engine | DbHandle | None = None,
        paths: OlivePaths | None = None,
        config_dir: str | None = None,
        meetings_dir: str | None = None,
        backups_dir: str | None = None,
        database_path: str | None = None,
        settings_path: str | None = None,
        plaud_tokens_path: str | None = None,
        logger: Logger | None = None,
    ) -> None:
        opts = options or {}
        resolved = paths or opts.get("paths") or resolve_paths()
        self.config_dir = str(
            config_dir or opts.get("configDir") or opts.get("config_dir") or resolved.config_dir
        )
        self.meetings_dir = str(
            meetings_dir
            or opts.get("meetingsDir")
            or opts.get("meetings_dir")
            or resolved.meetings_dir
        )
        self.backups_dir = str(
            backups_dir
            or opts.get("backupsDir")
            or opts.get("backups_dir")
            or resolved.backups_dir
        )
        self.database_path = str(
            database_path
            or opts.get("databasePath")
            or opts.get("database_path")
            or resolved.database_path
        )
        self.settings_path = str(
            settings_path
            or opts.get("settingsPath")
            or opts.get("settings_path")
            or resolved.settings_path
        )
        self.plaud_tokens_path = str(
            plaud_tokens_path
            or opts.get("plaudTokensPath")
            or opts.get("plaud_tokens_path")
            or resolved.plaud_tokens_path
        )
        raw_db = db or opts.get("db")
        if isinstance(raw_db, DbHandle):
            self.db: Engine = raw_db.engine
        elif isinstance(raw_db, Engine):
            self.db = raw_db
        else:
            self.db = get_db()
        self.logger: Logger = logger or opts.get("logger") or default_logger

    def _generate_backup_filename(self) -> str:
        now = datetime.now(tz=UTC)
        return f"olive-backup-{now.strftime('%Y%m%d-%H%M%S')}.tar.gz"

    def _scan_meetings_directory(self, meetings_dir: str | Path) -> dict[str, int]:
        audio_files_count = 0
        total_audio_size_bytes = 0
        summary_files_count = 0
        mdir = Path(meetings_dir)
        if not mdir.exists():
            return {
                "audioFilesCount": 0,
                "totalAudioSizeBytes": 0,
                "summaryFilesCount": 0,
            }

        try:
            for entry in mdir.iterdir():
                if not entry.is_dir():
                    continue
                audio_dir = entry / "audio"
                if audio_dir.is_dir():
                    for af in audio_dir.iterdir():
                        if af.is_file():
                            audio_files_count += 1
                            try:
                                total_audio_size_bytes += af.stat().st_size
                            except Exception:
                                pass
                summaries_dir = entry / "summaries"
                if summaries_dir.is_dir():
                    for sf in summaries_dir.iterdir():
                        if sf.is_file() and sf.name.endswith(".md"):
                            summary_files_count += 1
        except Exception as exc:
            self.logger.warn("Failed scanning meetings directory for metrics", {"error": str(exc)})

        return {
            "audioFilesCount": audio_files_count,
            "totalAudioSizeBytes": total_audio_size_bytes,
            "summaryFilesCount": summary_files_count,
        }

    def _snapshot_database(self, staging_db_path: Path) -> None:
        db_file = Path(self.database_path)
        if db_file.exists():
            try:
                src_conn = sqlite3.connect(str(db_file))
                dst_conn = sqlite3.connect(str(staging_db_path))
                try:
                    src_conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                    src_conn.backup(dst_conn)
                finally:
                    dst_conn.close()
                    src_conn.close()
                return
            except Exception as exc:
                self.logger.warn(
                    "sqlite3.backup failed, falling back to direct copy",
                    {"error": str(exc)},
                )
                shutil.copy2(db_file, staging_db_path)
                return

        # In-memory engine or non-existent file fallback: backup from self.db raw connection
        dst_conn = sqlite3.connect(str(staging_db_path))
        try:
            raw = self.db.raw_connection()
            try:
                src_conn: sqlite3.Connection = raw.driver_connection  # type: ignore[assignment]
                src_conn.backup(dst_conn)
            finally:
                raw.close()
        except Exception:
            pass
        finally:
            dst_conn.close()

    def _query_db_counts(self, db_path: Path) -> dict[str, int]:
        counts = {
            "meetings": 0,
            "recordings": 0,
            "speakers": 0,
            "templates": 0,
            "summaries": 0,
        }
        try:
            conn = sqlite3.connect(str(db_path))
            try:
                for tbl in ("meetings", "recordings", "speakers", "templates"):
                    try:
                        row = conn.execute(f"SELECT COUNT(*) FROM {tbl}").fetchone()
                        counts[tbl] = int(row[0]) if row else 0
                    except Exception:
                        pass
                try:
                    s_row = conn.execute(
                        "SELECT COUNT(*) FROM artifacts WHERE kind = 'summary'"
                    ).fetchone()
                    counts["summaries"] = int(s_row[0]) if s_row else 0
                except Exception:
                    pass
            finally:
                conn.close()
        except Exception as exc:
            self.logger.warn("Could not query staging DB stats", {"error": str(exc)})
        return counts

    async def create_backup(self, options: dict[str, Any] | None = None) -> dict[str, Any]:
        opts = options or {}
        filename = str(opts.get("filename") or self._generate_backup_filename())
        Path(self.backups_dir).mkdir(parents=True, exist_ok=True)
        target_archive_path = Path(self.backups_dir) / filename

        with tempfile.TemporaryDirectory(prefix="olive-backup-staging-") as staging_str:
            staging_dir = Path(staging_str)
            self.logger.info(
                "Creating Olive backup archive",
                {"targetArchivePath": str(target_archive_path)},
            )

            # 1. Snapshot database
            staging_db_path = staging_dir / "olive.sqlite"
            self._snapshot_database(staging_db_path)

            # 2. Query counts
            counts = self._query_db_counts(staging_db_path)

            # 3. Copy settings, tokens & custom model catalog
            if Path(self.settings_path).exists():
                shutil.copy2(self.settings_path, staging_dir / "settings.json")
            if Path(self.plaud_tokens_path).exists():
                shutil.copy2(self.plaud_tokens_path, staging_dir / "plaud-tokens.json")
            models_path = Path(self.config_dir) / "models.json"
            if models_path.exists():
                shutil.copy2(models_path, staging_dir / "models.json")

            # 4. Copy meetings directory
            staging_meetings_dir = staging_dir / "meetings"
            if Path(self.meetings_dir).exists():
                shutil.copytree(self.meetings_dir, staging_meetings_dir, dirs_exist_ok=True)
            else:
                staging_meetings_dir.mkdir(parents=True, exist_ok=True)

            disk_metrics = self._scan_meetings_directory(staging_meetings_dir)
            summary_count = counts["summaries"]
            if summary_count == 0 and disk_metrics["summaryFilesCount"] > 0:
                summary_count = disk_metrics["summaryFilesCount"]

            # 5. Generate and write manifest.json
            now_iso = datetime.now(tz=UTC).isoformat().replace("+00:00", "Z")
            manifest = BackupManifest(
                version="1.0.0",
                createdAt=now_iso,
                oliveVersion="0.2.0",
                app="olive",
                stats=BackupManifestStats(
                    meetingCount=counts["meetings"],
                    recordingCount=counts["recordings"],
                    audioFilesCount=disk_metrics["audioFilesCount"],
                    totalAudioSizeBytes=disk_metrics["totalAudioSizeBytes"],
                    summaryCount=summary_count,
                    speakerCount=counts["speakers"],
                    templateCount=counts["templates"],
                ),
            )
            (staging_dir / "manifest.json").write_text(
                f"{json.dumps(manifest.model_dump(), indent=2)}\n",
                encoding="utf-8",
            )

            # 6. Build compressed tar.gz archive
            with tarfile.open(target_archive_path, "w:gz") as tar:
                for item in staging_dir.iterdir():
                    tar.add(item, arcname=item.name)

            size_bytes = target_archive_path.stat().st_size
            self.logger.info(
                "Olive backup archive created successfully",
                {
                    "filename": filename,
                    "sizeBytes": size_bytes,
                    "stats": manifest.stats.model_dump(),
                },
            )
            return {
                "filename": filename,
                "path": str(target_archive_path),
                "sizeBytes": size_bytes,
                "createdAt": manifest.createdAt,
                "manifest": manifest.model_dump(),
            }

    createBackup = create_backup

    async def read_manifest_from_archive(self, archive_path: str | Path) -> BackupManifest | None:
        p = Path(archive_path)
        if not p.exists():
            return None
        try:
            with tarfile.open(p, "r:gz") as tar:
                for member in tar.getmembers():
                    norm = member.name.lstrip("./")
                    if norm in ("manifest.json", "backup_manifest.json"):
                        f = tar.extractfile(member)
                        if f:
                            raw = json.loads(f.read().decode("utf-8"))
                            return BackupManifest.model_validate(raw)
        except Exception as exc:
            self.logger.warn(
                "Failed reading manifest from archive",
                {"archivePath": str(p), "error": str(exc)},
            )
        return None

    readManifestFromArchive = read_manifest_from_archive

    async def list_backups(self) -> list[dict[str, Any]]:
        bdir = Path(self.backups_dir)
        if not bdir.exists():
            return []

        results: list[BackupInfo] = []
        for f in bdir.iterdir():
            if not f.is_file() or not (f.name.endswith(".tar.gz") or f.name.endswith(".tgz")):
                continue
            try:
                st = f.stat()
                manifest = await self.read_manifest_from_archive(f)
                mtime_iso = (
                    datetime.fromtimestamp(st.st_mtime, tz=UTC)
                    .isoformat()
                    .replace("+00:00", "Z")
                )
                results.append(
                    BackupInfo(
                        filename=f.name,
                        sizeBytes=st.st_size,
                        createdAt=manifest.createdAt if manifest else mtime_iso,
                        manifest=manifest,
                    )
                )
            except Exception as exc:
                self.logger.warn(
                    "Failed inspecting backup file",
                    {"file": f.name, "error": str(exc)},
                )

        results.sort(key=lambda b: b.createdAt, reverse=True)
        return [r.model_dump() for r in results]

    listBackups = list_backups

    def get_backup_path(self, filename: str) -> str:
        clean_name = Path(filename).name
        if clean_name != filename or ".." in filename or "/" in filename or "\\" in filename:
            raise ValueError("Invalid backup filename")
        full_path = Path(self.backups_dir) / filename
        if not full_path.exists():
            raise FileNotFoundError(f"Backup file {filename} not found")
        return str(full_path)

    getBackupPath = get_backup_path

    async def delete_backup(self, filename: str) -> None:
        full_path = Path(self.get_backup_path(filename))
        full_path.unlink()
        self.logger.info("Deleted backup archive", {"filename": filename})

    deleteBackup = delete_backup

    async def restore_backup(
        self,
        source: str | bytes | bytearray | memoryview,
        options: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        opts = options or {"rollbackOnError": True}
        rollback_on_error = opts.get("rollbackOnError", True)

        with (
            tempfile.TemporaryDirectory(prefix="olive-restore-extract-") as extract_str,
            tempfile.TemporaryDirectory(prefix="olive-restore-rollback-") as rollback_str,
        ):
            extract_dir = Path(extract_str)
            rollback_dir = Path(rollback_str)

            if isinstance(source, str):
                archive_path = (
                    Path(source)
                    if Path(source).exists()
                    else Path(self.get_backup_path(source))
                )
            else:
                archive_path = extract_dir / "upload-archive.tar.gz"
                archive_path.write_bytes(bytes(source))

            self.logger.info("Starting Olive restore", {"archivePath": str(archive_path)})

            try:
                # 1. Safely extract archive
                with tarfile.open(archive_path, "r:gz") as tar:
                    for member in tar.getmembers():
                        member_path = (extract_dir / member.name).resolve()
                        if not str(member_path).startswith(str(extract_dir.resolve())):
                            raise ValueError(f"Unsafe tar member path: {member.name}")
                    tar.extractall(path=extract_dir, filter="data")

                # 2. Locate olive.sqlite (root or database/olive.sqlite)
                extracted_db = extract_dir / "olive.sqlite"
                if not extracted_db.exists():
                    alt_db = extract_dir / "database" / "olive.sqlite"
                    if alt_db.exists():
                        extracted_db = alt_db
                    else:
                        raise ValueError("Invalid backup archive: missing 'olive.sqlite' database")

                # Verify SQLite integrity
                test_conn = sqlite3.connect(str(extracted_db))
                try:
                    test_conn.execute("SELECT 1").fetchone()
                finally:
                    test_conn.close()

                manifest: BackupManifest | None = None
                for mname in ("manifest.json", "backup_manifest.json"):
                    mfile = extract_dir / mname
                    if mfile.exists():
                        try:
                            manifest = BackupManifest.model_validate(
                                json.loads(mfile.read_text(encoding="utf-8"))
                            )
                            break
                        except Exception:
                            pass

                # 3. Create rollback checkpoint
                if rollback_on_error:
                    try:
                        if Path(self.database_path).exists():
                            shutil.copy2(self.database_path, rollback_dir / "olive.sqlite")
                        if Path(self.settings_path).exists():
                            shutil.copy2(self.settings_path, rollback_dir / "settings.json")
                        if Path(self.plaud_tokens_path).exists():
                            shutil.copy2(
                                self.plaud_tokens_path, rollback_dir / "plaud-tokens.json"
                            )
                    except Exception:
                        pass

                # 4. Dispose existing DB connections
                close_db()
                try:
                    self.db.dispose()
                except Exception:
                    pass

                # 5. Replace database file
                db_target = Path(self.database_path)
                db_target.parent.mkdir(parents=True, exist_ok=True)
                for suffix in ("-wal", "-shm", ""):
                    Path(f"{self.database_path}{suffix}").unlink(missing_ok=True)
                shutil.copy2(extracted_db, db_target)

                # 6. Restore settings.json, plaud-tokens.json, models.json
                if (extract_dir / "settings.json").exists():
                    Path(self.settings_path).parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(extract_dir / "settings.json", self.settings_path)
                if (extract_dir / "plaud-tokens.json").exists():
                    Path(self.plaud_tokens_path).parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(extract_dir / "plaud-tokens.json", self.plaud_tokens_path)
                if (extract_dir / "models.json").exists():
                    shutil.copy2(
                        extract_dir / "models.json", Path(self.config_dir) / "models.json"
                    )

                # 7. Restore meetings folder
                extracted_meetings = extract_dir / "meetings"
                if extracted_meetings.exists():
                    Path(self.meetings_dir).mkdir(parents=True, exist_ok=True)
                    shutil.copytree(extracted_meetings, self.meetings_dir, dirs_exist_ok=True)

                # 8. Re-open database handle and run migrations
                handle = reset_db_handle(self.database_path)
                self.db = handle.engine
                clear_app_config_cache()

                # 9. Query restored stats
                counts = self._query_db_counts(db_target)
                disk_metrics = self._scan_meetings_directory(self.meetings_dir)
                summary_count = counts["summaries"]
                if summary_count == 0 and disk_metrics["summaryFilesCount"] > 0:
                    summary_count = disk_metrics["summaryFilesCount"]

                res = RestoreResult(
                    success=True,
                    restoredAt=datetime.now(tz=UTC).isoformat().replace("+00:00", "Z"),
                    manifest=manifest,
                    stats=RestoreStats(
                        meetings=counts["meetings"],
                        recordings=counts["recordings"],
                        audioFiles=disk_metrics["audioFilesCount"],
                        summaries=summary_count,
                        speakers=counts["speakers"],
                        templates=counts["templates"],
                    ),
                )
                self.logger.info(
                    "Olive restore completed successfully",
                    {"stats": res.stats.model_dump()},
                )
                return res.model_dump()
            except Exception as exc:
                self.logger.error("Restore failed", {"error": str(exc)})
                if rollback_on_error:
                    try:
                        if (rollback_dir / "olive.sqlite").exists():
                            shutil.copy2(rollback_dir / "olive.sqlite", self.database_path)
                        if (rollback_dir / "settings.json").exists():
                            shutil.copy2(rollback_dir / "settings.json", self.settings_path)
                        if (rollback_dir / "plaud-tokens.json").exists():
                            shutil.copy2(
                                rollback_dir / "plaud-tokens.json", self.plaud_tokens_path
                            )
                        reset_db_handle(self.database_path)
                    except Exception:
                        pass
                raise

    restoreBackup = restore_backup
