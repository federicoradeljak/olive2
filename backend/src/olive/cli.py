"""Olive CLI (replaces scripts/backup.ts, scripts/restore.ts, scripts/download-models.ts)."""

from __future__ import annotations

import asyncio
import os
import shutil
from pathlib import Path

import typer

from .main import run_server
from .ml.asr_cohere import (
    COHERE_INT8_ONNX_REPO,
    COHERE_PROCESSOR_REPO,
    stage_cohere_int8_model_dir,
)
from .ml.embed import WESPEAKER_FILENAME, WESPEAKER_REPO_ID
from .services.backup import BackupService
from .settings import get_effective_hf_token, resolve_paths

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
    paths = resolve_paths()
    token = get_effective_hf_token()
    if token:
        os.environ["HF_TOKEN"] = token

    from huggingface_hub import hf_hub_download

    typer.echo(f"Downloading WeSpeaker model ({WESPEAKER_REPO_ID})...")
    hf_hub_download(repo_id=WESPEAKER_REPO_ID, filename=WESPEAKER_FILENAME, token=token)

    typer.echo("Downloading ctc-forced-aligner MMS-300m ONNX model...")
    from ctc_forced_aligner import MODEL_URL, ensure_onnx_model

    align_dir = Path(paths.models_dir) / "aligner"
    align_dir.mkdir(parents=True, exist_ok=True)
    ensure_onnx_model(str(align_dir / "mms-300m-aligner.onnx"), MODEL_URL)

    typer.echo("Downloading pyannote speaker-diarization-community-1...")
    from .ml.diarize import PyannoteSpeakerDiarizer

    PyannoteSpeakerDiarizer()._ensure_pipeline_sync()

    typer.echo(f"Downloading Cohere Transcribe 03-2026 INT8 ONNX ({COHERE_INT8_ONNX_REPO})...")
    from transformers import AutoProcessor

    AutoProcessor.from_pretrained(COHERE_PROCESSOR_REPO, token=token)
    stage_cohere_int8_model_dir(token)

    typer.echo("All local ML models downloaded successfully.")


if __name__ == "__main__":
    app()
