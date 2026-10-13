"""Olive CLI (replaces scripts/backup.ts, scripts/restore.ts, scripts/download-models.ts)."""

from __future__ import annotations

import asyncio
import os
import shutil
from pathlib import Path

import typer

from .main import run_server
from .ml.model_store import ModelStorageError, download_local_models
from .services.backup import BackupService
from .settings import get_effective_hf_token

app = typer.Typer(help="Olive — Self-Hosted AI Meeting Intelligence CLI")
models_app = typer.Typer(help="Manage local ML speech & diarization models")
app.add_typer(models_app, name="models")


@app.command("serve")
def serve_cmd() -> None:
    """Start the Olive HTTP and MCP server."""
    run_server()


@app.command("backup")
def backup_cmd(
    output_path: str | None = typer.Argument(
        default=None, help="Optional destination path for the .tar.gz backup archive"
    ),
) -> None:
    """Create a full .tar.gz system backup archive."""

    async def _run() -> None:
        service = BackupService()
        res = await service.create_backup()
        if output_path:
            dest = Path(output_path).resolve()
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(res["path"], dest)
            typer.echo(f"Backup written to {dest} ({res['sizeBytes']} bytes)")
        else:
            typer.echo(f"Backup created at {res['path']} ({res['sizeBytes']} bytes)")

    asyncio.run(_run())


@app.command("restore")
def restore_cmd(
    archive_path: str = typer.Argument(..., help="Path to the .tar.gz backup archive to restore"),
) -> None:
    """Restore an Olive system backup (.tar.gz)."""

    async def _run() -> None:
        service = BackupService()
        res = await service.restore_backup(str(Path(archive_path).resolve()))
        typer.echo(f"Restore complete: {res['stats']}")

    asyncio.run(_run())


@models_app.command("download")
def download_models_cmd() -> None:
    """Pre-download local WeSpeaker, pyannote, MMS aligner, and Cohere INT8 models."""
    token = get_effective_hf_token()
    if token:
        os.environ["HF_TOKEN"] = token
    try:
        download_local_models(token)
    except ModelStorageError as exc:
        typer.echo(f"Error: {exc}", err=True)
        raise typer.Exit(code=1) from exc


if __name__ == "__main__":
    app()
