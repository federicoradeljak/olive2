# Olive → Python Backend Migration Plan

Status: **decisions locked (grilling session, Q1–Q23)** — awaiting final confirmation.

## Goal

Replace the Bun/TypeScript server (`packages/server`, `packages/shared`, ~11k LOC + ~20 test files)
with a Python backend so the ML pipeline runs on the native Python speech ecosystem
(pyannote, WeSpeaker, HF transformers, CTC aligners) **in-process** — no IPC boundary.
Keep the React UI in TypeScript on a mainstream build toolchain.

### Constraints

- **No new features.** Behavioural parity with today, minus llama.cpp / Qwen3-ASR. The one
  small addition is an HF token field in Settings (needed for gated pyannote models).
- **Data compatibility:** existing `olive.sqlite`, `settings.json`, meeting folders
  (`<meetingsDir>/<date>_<title>__<id8>/{audio,transcripts,summaries}`), enrollment clips,
  Plaud tokens, and existing `.tar.gz` backups must work unmodified.
  **Exception:** local voiceprint vectors need not be preserved (they're regenerated from clips).
- **API:** keep REST routes identical by default; changes are allowed where they make the port
  easier. Stable external contracts: `POST /api/ingest` (iOS Shortcut), `/mcp`,
  `POST /api/webhooks/speechmatics`.
- Prefer off-the-shelf libraries over bespoke code.
- **Accuracy is the top priority** for all ML choices. Personal use only, so non-commercial
  (CC-BY-NC) model licenses are acceptable.
- Target host: **8 GB RAM**, CPU-only for v1. Apple Silicon (Metal) and Vulkan are the
  intended future accelerators, so the ML layer must make backend swaps cheap.

---

## Decisions log

| # | Decision |
| :--- | :--- |
| Q1/D6 | REST routes kept identical; deviate only where it simplifies the port. |
| Q2 | Use the best available diarization: **pyannote.audio 4 `speaker-diarization-community-1`**. No need to preserve existing embeddings. |
| Q3/Q6 | **CPU-only v1** (one Docker image; native macOS also CPU). Apple Silicon + Vulkan are primary *future* targets; measure CPU performance first. |
| Q4 | **Tailwind v3** kept. |
| Q5/Q13 | Local ASR: **Cohere Transcribe 03-2026** (HF transformers ≥5.4, `CohereAsrForConditionalGeneration`) behind a **swappable `AsrBackend` interface** so a GGML Metal/Vulkan backend (transcribe.cpp / CrispASR) or Parakeet can be added later. Larger Parakeet variants were checked and are less accurate (AMI WER: Cohere 7.02, Parakeet-TDT-0.6B-v2 9.09, Canary-1B-v2 13.03). |
| Q7/Q14 | No existing Python Plaud lib uses the PKCE developer API → **port `@mcowger/plaud-client`, vendored** at `backend/src/olive/plaud/`. Same `tokens.json` shape → no re-auth. |
| Q8/Q9 | HF token entered in the **Settings UI**, stored as `hfToken` in `settings.json`; `HF_TOKEN` env takes precedence; masked in `GET /api/config`. |
| Q10 | Background work: **asyncio tasks + APScheduler in the uvicorn process, plus one ML subprocess.** |
| Q11 | **Big-bang rewrite** in this worktree; Bun is deleted at cutover. |
| Q12 | Layout: **`backend/` + `frontend/`**; `packages/` removed. |
| Q15 | LLM calls via **any-llm** (Mozilla). |
| Q16 | Frontend types **generated from FastAPI OpenAPI** via openapi-typescript; CI fails on drift. |
| Q17 | Model catalog from **models.dev** `api.json`, cached in configDir (replaces `models-web-cache.json`) with a bundled snapshot fallback. |
| Q18 | Pipeline: **whole-file ASR → forced alignment → assign words to diarization turns.** |
| Q19 | Aligner chosen **purely on accuracy** in Phase 0: MMS-300m (CC-BY-NC) vs English wav2vec2-large via `ctc-forced-aligner`. |
| Q20 | Voiceprints from a **dedicated, stronger speaker-embedding model** (WeSpeaker ResNet293 / ResNet221 candidates), separate from diarization's internal model. |
| Q21 | Cohere **int8** default (precision configurable). ML worker **loads models per stage and frees them**; the worker exits after N idle minutes. |
| Q22 | Phase 0 evaluation on the **AMI corpus only**. |
| Q23 | UI engine picker reduced to **Local (Cohere + diarization)** / **Speechmatics**. `localAsrModel` is kept internally for future backends; Qwen values are coerced to the default on load. |

---

## Target stack

### Backend (Python 3.12, uv)

| Concern | Today (Bun) | Python replacement |
| :--- | :--- | :--- |
| Project / deps | bun | **uv** (`pyproject.toml`, `uv.lock`) |
| Lint / format / types | tsc | **ruff** + **basedpyright** |
| HTTP | Hono | **FastAPI** + **uvicorn** |
| Validation / models | zod (`@olive/shared`) | **Pydantic v2** (camelCase aliases → same JSON) |
| Env config | hand-rolled | **pydantic-settings** (same `OLIVE_*` vars) |
| `settings.json` | zod + fs | Pydantic model, same file/keys/defaults, + `hfToken` |
| SQLite | Kysely + bun:sqlite | **SQLAlchemy 2.0** (stdlib `sqlite3`) |
| Migrations | additive DDL | **Alembic**, baseline = today's schema; legacy DBs auto-stamped |
| SSE | hono/streaming | **sse-starlette** |
| Static SPA / audio Range | Hono | Starlette `StaticFiles` / `FileResponse` |
| Scheduling (Plaud poll) | setInterval | **APScheduler** (AsyncIOScheduler) |
| Retry / backoff | `plaud/retry.ts` | **tenacity** |
| HTTP client | fetch | **httpx** |
| Plaud | `@mcowger/plaud-client` | vendored port: httpx + **authlib** (PKCE) + Pydantic |
| LLM | pi-ai | **any-llm** |
| Model catalog | pi-catalog | **models.dev** JSON (cached + bundled snapshot) |
| Speechmatics | `@speechmatics/batch-client` | **speechmatics-batch** (official SDK) |
| MCP | `@modelcontextprotocol/server` | **mcp** official SDK (FastMCP, streamable HTTP at `/mcp`) |
| Logs table | custom logger | stdlib `logging` + DB handler (same `logs` table/UI) |
| Backup | `tar` npm | stdlib `tarfile` + `sqlite3` backup API |
| Audio decode / enhance | ffmpeg + custom WAV parser | ffmpeg subprocess (same filter chain) → numpy (**soundfile**) |
| Vector math | hand-written loops | **numpy** |
| ML worker | `worker_threads` | `multiprocessing` (spawn), killable for cancel |
| Tests | bun test | **pytest**, pytest-asyncio, FastAPI `TestClient`, **respx** |
| CLI | bun scripts | **typer**: `olive serve | backup | restore | models download` |

### ML stack (CPU, v1)

| Stage | Library / model | Notes |
| :--- | :--- | :--- |
| Diarization | **pyannote.audio 4**, `pyannote/speaker-diarization-community-1` | Gated; HF token from Settings/env. Use the `exclusive_speaker_diarization` output for word assignment. CPU only (MPS is broken in pyannote). |
| ASR | **Cohere Transcribe 03-2026** via `transformers` ≥5.4 (not 5.0/5.1), long-form chunking | int8 default (dynamic quant via `torch.ao` or bitsandbytes CPU; chosen in Phase 0), bf16/fp32 configurable. |
| Word timestamps | **ctc-forced-aligner** with MMS-300m *or* wav2vec2-large English | Phase 0 picks on timing MAE vs AMI word timings. |
| Voiceprints | **WeSpeaker** ResNet293 or ResNet221 (via `wespeaker` or pyannote `Inference`) | Embeddings per aligned speaker turn; trusted-vector scoring ported from `embedding.ts`. |
| Interface | `AsrBackend`, `Aligner`, `Diarizer`, `SpeakerEmbedder` protocols | So Metal/Vulkan backends (transcribe.cpp, CrispASR, parakeet.cpp, MLX) can be added later without touching orchestration. |

**Worker memory discipline (8 GB host):** the worker runs stages one after another: decode →
diarize (load pyannote, run, free) → ASR (load Cohere int8, run, free) → align (load, run, free)
→ embed (load, run, free). Target peak ≈ 3 GB. Models are cached on disk under
`OLIVE_MODELS_DIR` (`HF_HOME`). The worker process exits after `OLIVE_ML_IDLE_MINUTES`
(default 10) idle, returning RAM to the OS.

### Frontend

| Concern | Target |
| :--- | :--- |
| Package manager | **pnpm** |
| Bundler / dev | **Vite** + `@vitejs/plugin-react` + `babel-plugin-react-compiler` |
| Dev API | Vite `server.proxy` → uvicorn (`/api`, `/mcp`) |
| CSS | Tailwind v3 via PostCSS |
| API types | **openapi-typescript** → `src/api/schema.d.ts` (optionally **openapi-fetch**) |
| Typecheck | `tsc --noEmit` |

`main.tsx` changes: type imports, remove the Qwen engine option (selects at ~L1768/L3185 plus labels),
and add the HF token field to Settings. Nothing else.

---

## Repository layout (target)

```
backend/
  pyproject.toml  uv.lock  alembic.ini
  migrations/                      # 0001_baseline = current schema
  src/olive/
    main.py  settings.py  layout.py  logging_db.py  schemas.py  cli.py  mcp_server.py
    db/                            # engine, models, seeding, plaud-duration repair
    api/                           # routers (one per current route group)
    services/                      # meetings, ingest, transcription, speakers, summaries,
                                   # chat, templates, llm, catalog, backup
    providers/speechmatics/        # client + normalize
    ml/                            # protocols.py, audio.py, diarize.py, asr_cohere.py,
                                   # align.py, embed.py, scoring.py, pipeline.py, worker.py
    plaud/                         # auth.py, client.py, token_store.py, formatters.py, poller.py
  tests/
  eval/                            # Phase 0 AMI harness (kept for regression benchmarking)
frontend/
  package.json  pnpm-lock.yaml  vite.config.ts  tsconfig.json  tailwind.config.js  postcss.config.js
  index.html  public/  src/
Dockerfile  .github/workflows/  README.md
```

Deleted at cutover: `packages/`, `bun.lock`, `dev.ts`, `scripts/*.ts` (replaced by CLI / dev
tooling), llama.cpp fetch/vendor code, `docs/` references to Bun.

---

## Data compatibility

1. **Paths:** exact port of `resolvePaths` (same env vars, per-OS defaults).
2. **settings.json:** same keys and defaults, plus `hfToken`. `localAsrModel` values containing
   `qwen` are coerced to the Cohere default. Thresholds get new defaults from Phase 0, and
   **existing saved threshold values are reset** once, since they were tuned for ERes2Net.
   That reset is recorded in `sync_state`.
3. **Database:** SQLAlchemy models mirror the 11 tables exactly (TEXT JSON, epoch-ms ints,
   TEXT UUIDs). Alembic `0001_baseline`. On startup: if `alembic_version` is missing and
   `meetings` exists, stamp `0001`, then run `upgrade head`. WAL and `foreign_keys` are set on connect.
   Template seeding and the Plaud duration repair stay idempotent startup steps.
4. **Artifacts:** Pydantic `Transcript`/`Segment`/`Word` models with camelCase aliases. A
   round-trip test runs over fixture artifacts.
5. **Folder naming:** `layout.py` is byte-identical to `layout.ts`, checked with golden tests (unicode, slashes, long titles).
6. **Voiceprints:** drop `provider_ids.local` vectors. Store `local_embedding_model` in
   `sync_state`. When it changes (including the first boot), a background job rebuilds every speaker from
   enrollment clips (port of the rebuild flow). Speechmatics identifiers are untouched.
7. **llm_settings:** same `sync_state` row and shape. Provider ids are mapped to any-llm provider
   names on load (e.g. `google` → `gemini`). Thinking levels map to any-llm `reasoning_effort`.
8. **Backups:** restore accepts both legacy layouts (`manifest.json` / `backup_manifest.json`;
   DB at root or `database/`) and runs migrations after restore. A fixture archive is made by the Bun build
   before it's deleted.
9. **Plaud tokens:** same path and JSON (`access_token`, `refresh_token`, `token_type`,
   `expires_at` epoch-ms), same file modes (0700/0600), same 48 h proactive refresh.

---

## Phases

Every phase ends with green pytest/tsc and a smoke test against a **copy** of a real data dir.

### Phase 0 — ML evaluation on AMI (decision gate)
Harness in `backend/eval/` on an AMI subset (headset-mix, ~10 meetings, reference words with
timings + speaker labels):
- Cohere int8 vs bf16: WER (and RAM, RTF on target CPU).
- Aligner: MMS-300m vs wav2vec2-large English: word-boundary MAE, failure rate on long chunks.
- Full pipeline: DER and **cpWER** (speaker-attributed WER) for whole-file ASR + align + assign.
- Voiceprints: ResNet293 vs ResNet221 vs community-1 built-in: EER on AMI speakers, then set
  `localSimilarityThreshold`, decision margin, and clustering defaults from the EER operating point.
- **Exit:** lock aligner, embedding model, int8 method, and threshold defaults. Record numbers in `eval/RESULTS.md`.
  If 60-min-meeting CPU time is unacceptable, revisit the GGML backend priority.

### Phase 1 — Scaffolding
uv project, FastAPI factory + lifespan, settings/paths, SQLAlchemy + Alembic baseline/stamp,
DB log handler, `/api/health`, SPA serving. Vite frontend (move `packages/web/src`, Tailwind via
PostCSS, favicons in `public/`, proxy). Dev runner (`honcho`/Procfile: uvicorn `--reload` + `pnpm dev`).
CI: ruff, basedpyright, pytest, openapi drift check, `tsc`, `vite build`.

### Phase 2 — Core domain
Meetings CRUD, ingest (sha256 dedupe, ffprobe duration, layout, enhancement), audio Range,
templates, config (+ `hfToken` masking), logs. Generate TS types and switch imports.
Port: `migrations`, `ingest`, `meetings-delete`, `templates`, `logs`, `app` tests.

### Phase 3 — LLM, catalog, summaries, chat
any-llm service (providers, per-provider key/baseUrl/headers, custom models, thinking levels,
test/generate). models.dev catalog fetch/cache/snapshot + `refresh-catalog`. Summaries
(interpolation, primary, status). Chat SSE (assistant-ui wire format unchanged).
Port: `llm`, `summaries`, `chat` tests.

### Phase 4 — Speechmatics
Official SDK submit/poll/fetch, webhook verification, `normalize.py`, speaker-identifier
enrollment. Port: `speechmatics-normalize`, `speechmatics-client` tests (+ opt-in live test).

### Phase 5 — Local ML pipeline
`ml/` protocols and implementations per the Phase 0 choices. Pipeline stages and progress events
match today's (`decoding`, `diarizing`, `transcribing`, `finalizing`, …) so the UI is unchanged.
Spawned worker with per-stage load/free, idle exit, cancel = terminate + respawn, progress via
`multiprocessing.Queue` → SSE. Transcription service orchestration (provider choice, artifacts,
primary-artifact preference, auto-summary, active jobs). UI: remove Qwen and add the HF token field.
Port: `local-transcription`, `transcription`, `worker-runner` tests (fakes for each protocol).

### Phase 6 — Speakers
Port `speakers/service.ts` (enroll, link, reassign, confirm/unassign/split/merge segments, merge
speakers, backfill, rebuild, delete) on numpy. Embedding-model-change auto-rebuild.
Port `speakers.test.ts`.

### Phase 7 — Plaud
Vendored client (PKCE start/complete manual login, token store, 6 client methods, error types,
formatters) and poller (APScheduler, tenacity 429 backoff, dedupe/duplicate-audio logic,
`plaud_ingest_state`). Port `plaud.test.ts` with respx.

### Phase 8 — Backup/restore, MCP, CLI
Backup/restore with legacy layouts plus a fixture archive. FastMCP at `/mcp` with the existing
token/loopback and host/origin rules and the same tools. typer CLI including `models download`
(prefetches all ML models; requires the HF token). Port `backup`, `mcp` tests.

### Phase 9 — Packaging & cutover
Dockerfile: `node:22` + pnpm builds the SPA, then `python:3.12-slim` + `uv sync --frozen` + ffmpeg +
CPU torch wheels. Same env/port/`/app/data` volume, Vulkan/llama layers dropped. Update CI,
`docker-publish.yml`, staging deploy (port `deploy-staging.ts` to a shell script or the CLI), README,
`docs/API.md`, `.env.example`. Delete the Bun code.
Cutover checklist on a data-dir copy: old DB opens, audio plays, transcripts/summaries render,
voiceprint rebuild runs, local + Speechmatics transcription work, Plaud sync works without re-auth,
backup → restore round-trips.

---

## Testing strategy

- Each `*.test.ts` is ported in its owning phase, with test names preserved.
- **Golden contract snapshots:** before deleting Bun, record JSON from every GET route on a fixture
  data dir and assert the Python responses match in shape (volatile fields ignored).
- Data fixtures: a legacy DB, meeting folder, enrollment clips, and a Bun-made backup.
- ML: unit tests use fake protocol implementations. Opt-in `@pytest.mark.live` runs real models.
  `eval/` stays as a regression benchmark.

## Future (explicitly not v1)

- Metal / Vulkan acceleration: a GGML `AsrBackend` (transcribe.cpp / CrispASR for Cohere) and
  checking whether pyannote/aligner/embedder can run via ONNX Runtime CoreML or Vulkan EPs.
- Optional faster Parakeet backend.
- API cleanup, splitting `main.tsx`, Tailwind v4.

## Out of scope

New features (beyond the HF token field), UI redesign, llama.cpp/Qwen, external queues
(Redis/Celery), multi-process web workers.
