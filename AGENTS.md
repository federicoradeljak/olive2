# AGENTS.md

Repository guide for coding agents working in Olive.

## Stack & repository layout

Olive is a two-part repository:
- `backend/`: Python 3.12 backend managed by `uv` (`backend/pyproject.toml`, `backend/uv.lock`).
  - `src/olive/main.py` & `app.py`: FastAPI application factory, HTTP routes, SSE streams, and SPA static serving.
  - `src/olive/cli.py`: `typer` CLI (`olive serve`, `olive backup`, `olive restore`, `olive models download`).
  - `src/olive/settings.py` & `layout.py`: OS path resolution (`OLIVE_CONFIG_DIR`, `OLIVE_MEETINGS_DIR`, `OLIVE_MODELS_DIR`), `settings.json` persistence, and meeting folder naming (`<date>_<sanitized_title>__<id8>`).
  - `src/olive/schemas.py`: Pydantic v2 domain and API models (camelCase JSON serialization).
  - `src/olive/db/`: SQLAlchemy 2.0 models (`models.py`), engine/session management (`session.py`), and migrations/seeding (`migrations.py`). Alembic lives in `backend/alembic.ini` and `backend/migrations/`.
  - `src/olive/services/`: Domain services (`meetings.py`, `ingest.py`, `transcription.py`, `speakers.py`, `summaries.py`, `chat.py`, `templates.py`, `llm.py`, `backup.py`).
  - `src/olive/ml/`: Local ML speech pipeline:
    - `protocols.py`: `AsrBackend`, `Aligner`, `Diarizer`, `SpeakerEmbedder` protocols.
    - `audio.py`: FFmpeg audio decoding, speech enhancement filter, and `soundfile` WAV codec.
    - `diarize.py`: `PyannoteSpeakerDiarizer` (`pyannote/speaker-diarization-community-1`).
    - `embed.py` & `scoring.py`: `WeSpeakerEmbeddingExtractor` (`Wespeaker/wespeaker-voxceleb-resnet293-LM` ONNX, 256-dim) and `numpy` cosine/centroid scoring.
    - `asr_cohere.py`: `CohereAsrEngine` (`vigneshlabs/cohere-transcribe-03-2026-int8-onnx` via `onnxruntime` + `transformers` `CohereAsrProcessor`).
    - `align.py`: `CtcForcedAligner` (`ctc-forced-aligner` MMS-300m ONNX).
    - `pipeline.py` & `worker.py`: `LocalTranscriptionPipeline` and `LocalTranscriptionWorkerRunner`.
  - `src/olive/providers/speechmatics/`: Speechmatics batch client and json-v2 normalizer.
  - `src/olive/plaud/`: Vendored Plaud Cloud OAuth 2.0 PKCE client (`sdk.py`, `client.py`, `auth.py`), 429 retry backoff (`retry.py`), and background poller (`poller.py`).
  - `src/olive/mcp_server.py`: Read-only Model Context Protocol server mounted at `/mcp`.
  - `tests/`: `pytest` suite (`test_*.py`).
  - `eval/`: AMI corpus evaluation harness (`run_ami_eval.py`, `RESULTS.md`).
- `frontend/`: React 19 + TypeScript + Tailwind v3 SPA built with Vite and `pnpm`.
  - `src/main.tsx`: Application UI.
  - `src/api/schema.d.ts`: Generated from `../backend/openapi.json` via `openapi-typescript`. Do not hand-edit.
  - `src/api/types.ts`: Type aliases re-exported from `schema.d.ts`.

## Common commands

### Backend (`cd backend`)
- Install/sync deps: `uv sync`
- Lint: `uv run ruff check src tests eval`
- Typecheck: `uv run basedpyright`
- Run tests: `uv run pytest`
- Start dev server: `uv run uvicorn olive.main:app --reload --port 4471`

### Frontend (`cd frontend`)
- Install deps: `pnpm install`
- Regenerate OpenAPI types (after changing Pydantic schemas in `backend/src/olive/schemas.py`):
  ```bash
  cd backend && uv run python -c "import json; from olive.app import export_openapi_schema; open('openapi.json', 'w').write(json.dumps(export_openapi_schema(), indent=2) + '\n')"
  cd ../frontend && pnpm run generate:api
  ```
- Typecheck: `pnpm run typecheck`
- Build production bundle: `pnpm run build`

### Full Dev Stack & FRP Tunnel (repo root)
- Start backend + Vite HMR + optional `frpc` HTTP tunnel: `python3 scripts/dev.py`
- Get deterministic worktree FRP tunnel URL (`FRPC_SERVER_ADDR`, `FRPC_AUTH_TOKEN`, `FRPC_SUBDOMAIN_HOST`):
  - `python3 scripts/dev_config.py frp_url`
  - `python3 scripts/dev_config.py frp_url --json`
  - `python3 scripts/dev_config.py frp_url --subdomain`
  - `python3 scripts/dev_config.py frp_url --hostname`
  - `python3 scripts/dev_config.py frp_url --file`

## Invariants & rules

1. **Never touch `~/.config/olive` in tests.** All tests must use `:memory:` SQLite databases and `tmp_path` directories for `configDir`, `meetingsDir`, and `backupsDir`.
2. **Preserve on-disk & DB compatibility.**
   - SQLite timestamps are epoch milliseconds (`INTEGER`), IDs are UUID strings (`TEXT`), and JSON fields (`tags`, `provider_ids`, `enrollment_clip_paths`, `details`, `usage`) are stored as `TEXT`.
   - Meeting folder names (`layout.py`) must remain byte-identical to `YYYY-MM-DD_<sanitized_title>__<id[:8]>`.
   - Backup archives (`.tar.gz`) must remain compatible with both root `olive.sqlite`/`manifest.json` and legacy `database/olive.sqlite`/`backup_manifest.json` layouts.
3. **External API contracts.** Keep `POST /api/ingest` (used by the iOS Shortcut), `/mcp` (used by MCP clients), and `POST /api/webhooks/speechmatics` backward-compatible.
4. **OpenAPI drift check.** CI runs `pnpm run generate:api` and `git diff --exit-code src/api/schema.d.ts`. Whenever you change `backend/src/olive/schemas.py` or `export_openapi_schema()`, regenerate `backend/openapi.json` and `frontend/src/api/schema.d.ts`.
