# Changelog

All notable changes to Olive are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Olive is currently pre-1.0 (`0.2.0`); everything below shipped as part of the
0.2.0 development line unless a future version section says otherwise.

## [Unreleased]

<!-- Add new entries here under Added / Changed / Fixed. See AGENTS.md "Changelog policy". -->

### Added

- **Auto-title meetings** — generate a concise meeting title from the
  transcript with the configured default LLM via the Auto-title button
  next to the meeting title.

### Changed

- **Faster container startup** — model preflight skips Hugging Face Hub
  round-trips when the MMS aligner and staged Cohere INT8 files already
  exist, and verifies the four local models concurrently instead of
  sequentially.

### Fixed

- **Human-verified voiceprints always enroll** — confirming a speaker turn,
  reassigning a voice, or rapid-enrolling checked samples now trains the
  voiceprint even when the clip scores below the outlier threshold; a low
  score expands the voiceprint instead of rejecting your confirmation.

## [0.2.0] — 2026-10-14

Covers the full history from project start (2026-08-11) through 2026-10-14,
including the original TypeScript/Bun prototype era and the Python
FastAPI + Vite rewrite (2026-10-13).

### Added

- **Meetings management** — meeting list/detail views; rename with atomic
  on-disk folder move (`YYYY-MM-DD_<title>__<id8>`) and no re-import; tags
  (add/edit, trimmed and de-duplicated); delete from UI removing DB rows,
  artifacts, recordings, chat, Plaud state, logs, and the meeting folder.
- **Ingest** — audio upload API (`POST /api/ingest`, iOS Shortcut compatible);
  Plaud Cloud sync with OAuth 2.0 PKCE modal, 15-minute poller, auto-transcription,
  duplicate-audio detection (`duplicate` status, no re-download), migrated `of_`
  file-ID handling, HTTP 429 backoff with `Retry-After`, and background
  "Sync Now" (202 immediately).
- **Transcription providers** — Speechmatics batch STT with diarization and
  webhook; local on-device pipeline (Cohere Transcribe INT8 ONNX, IBM Granite
  Speech, Qwen3-ASR default, CTC forced alignment); AssemblyAI Universal-3.5
  provider with live upload/polling progress; provider selection honored with a
  UI dropdown and per-request override.
- **Transcription UX** — real-time SSE progress streaming that survives page
  navigation and covers runs started elsewhere; background execution (worker
  thread, then durable DBOS stage queues); cancellation that also cancels the
  underlying DBOS workflow and stays cancelled; bulk re-transcribe across
  meetings (`POST /api/meetings/bulk-transcribe`, selection checkboxes, queue
  backed); whole-number progress with realistic speaker-ID weighting.
- **Speakers & diarization** — speaker registry and People dashboard; in-meeting
  enrollment, reassignment, merging, and renaming; neural diarization
  (pyannote community-1) with WeSpeaker ResNet293-LM voiceprints as the single
  speaker-identity store; cross-recording voiceprint matching and ASR-first
  cloud speaker identification; Plaud transcript speakers matched to enrolled
  voiceprints; post-facto "Re-identify" for any transcript
  (`POST /api/meetings/{id}/speakers/reidentify`); rapid enrollment flow for
  unmatched groups; 12-second trim for over-long samples; voiceprint cap with
  outlier/near-duplicate filtering and UI notices; generic "Speaker N" labels
  treated as transcript-only (never people); segment coalescing, pruning, and
  inline segment add/edit/delete; tunable diarization/voiceprint thresholds.
- **Summaries, chat & search** — prompt templates and multi-provider LLM calling
  with per-model thinking levels; asynchronous summary generation with status
  polling; multi-summary management with markdown rendering and raw/rendered
  toggle; per-meeting chat grounded in summary, transcript, and speakers;
  full-text content search with auto-summarization on transcription completion.
- **Usage tracking** — cloud transcription (per audio hour) and LLM (per token)
  spend recorded with estimated USD, history backfilled, Usage tab plus
  per-meeting cost line.
- **System & platform** — backup/restore via API, UI, and CLI (root and legacy
  archive layouts); structured system logging with Logs API and UI view;
  read-only MCP server at `/mcp` (search meetings, read transcripts/summaries,
  action items); `/debug` DBOS stage-queues page and API with live per-stage
  display, bounded pipeline concurrency, and inter-stage queue status; favicons
  and PWA manifest; mobile experience (bottom tab bar, modal shell, no iOS zoom
  on inputs, select mode, responsive cards); FFmpeg speech-enhancement filter
  with player toggle.
- **Distribution & runtime** — Docker as primary distribution: first start
  downloads speech models (~4.5 GB) into a persistent `/app/models` volume and
  refuses to run without it; multi-arch (amd64/arm64) images built on native
  runners; Python 3.12 FastAPI/SQLAlchemy backend with Vite 6 + pnpm frontend
  and OpenAPI-generated types; durable DBOS SQLite stage queues
  (`pipeline`, `plaud_sync`, `ffmpeg`, `diarize`, `speaker_embed`, `asr`,
  `align`, `speechmatics`, `assemblyai`, `summarize`); ONNX inference offloaded
  to threads; clean shutdown of workflows, poller, SSE, and DBOS on SIGINT.

### Fixed

- Plaud duplicate-audio re-download loop (hundreds of GB re-fetched every poll
  cycle) resolved with permanent duplicate marking.
- Plaud auto-poll never firing (scheduler bound to a dead loop); now starts in
  the FastAPI lifespan. Manual sync, legacy ID migration, and 404 healing fixed.
- Headerless Plaud Opus recordings rejected by ffmpeg/cloud ASR; raw packets are
  now canonicalized to valid Ogg on disk (with startup migration of legacy files).
- Transcription provider config ignored (hard-defaulted to Speechmatics) and
  upload failures silent; now controlled and surfaced as explicit error events.
- Cancelled transcriptions flipping back to in-progress on late updates;
  recovered transcripts after restart now persist and mark ready.
- LLM settings wiping stored API keys on blank save; custom provider base URLs
  breaking across SDKs (`/v1` double-prefix).
- Speaker rename reverting until reload; deleting a meeting resetting page
  scroll/loading state; long transcription progress decimals.
- Plaud import showing redundant `Auto_sum_note` heading and leading separators;
  transcript parser rejecting `item.text` / `startMs` shapes and top-level array
  transcripts.
- Container restarts losing Plaud OAuth tokens (now persisted in `configDir` and
  included in backups); custom Speechmatics client requiring an API key.

### Changed

- Backend migrated from Bun/Hono TypeScript monorepo to Python FastAPI; frontend
  build migrated to Vite + pnpm (SQLite schema, config paths, and meeting folder
  layout preserved).
- Background work moved from subprocess/worker-thread to the DBOS durable
  job-queue system (the sole enqueue path; see AGENTS.md rule 5).
- Default local ASR model switched to Qwen3-ASR; diarizer/embedding throughput
  scales with host CPU cores.
- Test suite runs in ~17s via fake neural models and live-test gating.

### Infrastructure / chores

- Dockerfile with model pre-caching and GHCR publish; isolated multi-stage model
  layer with registry caching; staging deploy script and image tags.
- GitHub Actions bumped to latest majors (Node 24); Bun runtime 1.4 (TS era);
  pinned llama.cpp builds per platform (TS era).
- Docs: planning docs (HIGHLEVEL, MILESTONES, DESIGN), diarization-fix notes, ML
  acceleration plan, README features/architecture/screenshots, API docs,
  verification policy for coding agents.
