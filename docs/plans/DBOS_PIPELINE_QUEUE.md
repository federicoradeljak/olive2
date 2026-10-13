# DBOS SQLite job queue and staged pipeline architecture

## Problem statement

Olive's local transcription and background task execution originally came from a 1:1 port of the Node/TypeScript `worker-runner.ts` and `pipeline.ts` modules:

1. **In-memory queueing and raw tasks.** `LocalTranscriptionWorkerRunner._queue` in `backend/src/olive/ml/worker.py` is an in-memory Python list, and background work in `ingest.py`, `poller.py`, `transcription.py`, `summaries.py`, and `speakers.py` uses fire-and-forget `asyncio.create_task()` calls. Server restarts drop queued work and leave in-flight `stage_runs` rows stuck at `status = 'running'`.
2. **Subprocess-per-job cold starts.** `LocalTranscriptionWorkerRunner._run_in_subprocess()` spawns a fresh Python interpreter (`multiprocessing.get_context("spawn")`) for every meeting transcription, re-importing `torch`, `pyannote.audio`, `onnxruntime`, and `transformers` each time.
3. **Monolithic pipeline execution.** `LocalTranscriptionPipeline.transcribe()` runs `ffmpeg` decoding, Pyannote segmentation, WeSpeaker 256-d voiceprint extraction, speaker matching, Cohere ASR, and MMS CTC forced alignment inside one function while passing `float32` audio arrays in memory. Slow ML stages block fast I/O stages for other meetings, and failures late in the pipeline require re-running earlier stages from scratch.

## Architecture overview

Olive replaces the custom subprocess runner and ad-hoc background tasks with **DBOS (`dbos-transact-py`)** backed by SQLite.

### 1. DBOS system database and lifecycle (`src/olive/workflows/runtime.py`)

- **System database:** `sqlite:///<OLIVE_CONFIG_DIR>/dbos.sqlite`. Keeping DBOS workflow and queue state in a dedicated SQLite file alongside `olive.sqlite` avoids write-lock contention between DBOS queue polling and Olive's application queries.
- **Test isolation:** In tests, `ensure_dbos_launched(config_dir=...)` binds `dbos.sqlite` inside the test's `tmp_path` directory (or a per-instance temporary directory when `config_dir` is omitted) and never touches `~/.config/olive`. Shutdown calls `DBOS.destroy(destroy_registry=False)` so workflow and step registrations remain intact across multiple `create_app()` calls in a single `pytest` process.

### 2. Named stage queues (`src/olive/workflows/queues.py`)

Each pipeline stage runs on its own `DBOS.Queue` with concurrency tuned to its workload:

| Queue name | `worker_concurrency` | Purpose |
| :--- | :---: | :--- |
| `plaud_sync` | `1` | Plaud Cloud discovery, detail resolution, and audio download (`deduplication_id="plaud:poll"`) |
| `ffmpeg` | `2` | Audio decoding (`16k_mono.wav`) and FFmpeg speech enhancement (`enhanced.mp3`) |
| `diarize` | `1` | Pyannote neural speaker segmentation and VBx clustering |
| `speaker_embed` | `1` | WeSpeaker 256-d turn embedding extraction and enrolled speaker matching |
| `asr` | `1` | Cohere ONNX speech-to-text transcription |
| `align` | `1` | MMS CTC forced alignment, word-to-turn mapping, and transcript artifact generation |
| `speechmatics` | `2` | Speechmatics batch transcription and background speaker clip enrollment |
| `summarize` | `2` | LLM meeting summary generation |

### 3. Checkpointed local transcription DAG (`src/olive/workflows/transcription_workflow.py`)

Instead of passing `np.ndarray` buffers across a single function, each stage reads and writes intermediate files in `<meeting_folder>/transcripts/.work/` (or `<work_dir>/` when running standalone on raw audio paths/bytes) and checkpoints metadata in SQLite:

```text
[ffmpeg: step_decode_audio]
            │
            ▼
[diarize: step_diarize_turns]
       ┌────┴────┐
       ▼         ▼
[speaker_embed] [asr: step_transcribe_asr]
       └────┬────┘
            ▼
[align: step_align_and_finalize]
            │
            ▼
[summarize: step_auto_summarize]
```

1. **`step_decode_audio` (`ffmpeg` queue)**
   - Decodes input audio to 16 kHz mono float32 WAV at `<work_dir>/16k_mono.wav`.
   - Returns `{"wavPath": str, "durationMs": int, "sampleRate": 16000}`.
2. **`step_diarize_turns` (`diarize` queue)**
   - Calls `PyannoteSpeakerDiarizer.segment_turns()` on `16k_mono.wav`.
   - Coalesces same-speaker turns separated by `<= 1500 ms` and writes `<work_dir>/diarization.json` (`[{"startMs": int, "endMs": int, "speakerId": str}, ...]`).
3. **`step_embed_and_match_speakers` (`speaker_embed` queue)**
   - Calls `PyannoteSpeakerDiarizer.extract_cluster_voiceprints()` on `16k_mono.wav` and `diarization.json` using `WeSpeakerEmbeddingExtractor` (top 8 longest turns per cluster, capped at 12 seconds per turn).
   - Scores cluster centroids against enrolled speaker profiles using cosine similarity threshold and decision margin.
   - Writes `<work_dir>/speaker_clusters.json` (`clusterToResolvedName`, `discoveredSpeakers`, `clusterCentroids`, `clusterDiagnostics`).
4. **`step_transcribe_asr` (`asr` queue)**
   - Runs concurrently with `step_embed_and_match_speakers` since both only depend on `16k_mono.wav` and `diarization.json`.
   - Executes `CohereAsrEngine` (whole-file when `wholeFileAsr=True`, or per diarized turn) and writes `<work_dir>/raw_asr.json`.
5. **`step_align_and_finalize` (`align` queue)**
   - Combines `diarization.json`, `speaker_clusters.json`, and `raw_asr.json`.
   - Runs `CtcForcedAligner` (for whole-file ASR) or proportional word timestamp assignment, maps words/turns to resolved speaker names, coalesces adjacent speaker turns, and returns `LocalTranscriptionResult`.
   - Removes temporary `<work_dir>/16k_mono.wav` once complete while retaining lightweight JSON stage checkpoints.

### 4. `stage_runs` tracking, SSE progress, and cancellation

- **`stage_runs` synchronization:** `TranscriptionService` records both the top-level `local_transcribe` stage run (preserving existing API and UI contracts) and granular stage rows (`ffmpeg_decode`, `diarize`, `speaker_embed`, `asr`, `align`) in `olive.sqlite`.
- **Progress streaming:** Each stage emits progress through `TranscriptionService.emit_progress(meeting_id, update)` for active SSE clients on `GET /api/meetings/{id}/transcribe/progress` and records workflow events in DBOS.
- **Cancellation:** `cancel_transcription(meeting_id)` triggers the per-meeting `AbortController` (stopping in-flight ASR turn loops or diarization hooks at the next cooperative check) and calls `DBOS.cancel_workflow_async(workflow_id)` so queued downstream stages are cancelled in SQLite.

### 5. Service-wide background queue integration

- **`src/olive/ml/worker.py`:** `LocalTranscriptionWorkerRunner` dispatches jobs through the DBOS staged pipeline instead of spawning `multiprocessing` child processes.
- **`src/olive/services/ingest.py`:** Auto-transcription after audio ingest enqueues on DBOS with `deduplication_id=f"transcribe:{meeting_id}"`.
- **`src/olive/plaud/poller.py`:** Plaud poll cycles, audio enhancement (`ffmpeg` queue), and auto-transcription run as managed queue tasks.
- **`src/olive/services/summaries.py`:** Background summary generation runs on the `summarize` queue.
- **`src/olive/services/speakers.py`:** Background Speechmatics voiceprint enrollment runs on the `speechmatics` queue.
