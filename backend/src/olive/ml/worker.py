"""Background worker runner for local transcription with progress and cancellation (port of worker-runner.ts)."""

from __future__ import annotations

import asyncio
import inspect
import multiprocessing as mp
import os
import queue
import threading
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from ..logging_db import logger, set_log_sink
from ..schemas import EnrolledSpeaker, LogLevel, Transcript
from .pipeline import LocalTranscriptionPipeline
from .protocols import DiscoveredSpeakerVoiceprint, LocalTranscriptionResult


class AbortSignal:
    def __init__(self) -> None:
        self._event = threading.Event()
        self._listeners: list[Callable[[], Any]] = []

    @property
    def aborted(self) -> bool:
        return self._event.is_set()

    def is_set(self) -> bool:
        return self._event.is_set()

    def add_event_listener(self, _event_name: str, callback: Callable[[], Any]) -> None:
        if self._event.is_set():
            callback()
        else:
            self._listeners.append(callback)

    addEventListener = add_event_listener

    def _trigger(self) -> None:
        if self._event.is_set():
            return
        self._event.set()
        for cb in list(self._listeners):
            try:
                cb()
            except Exception:
                pass


class AbortController:
    def __init__(self) -> None:
        self.signal = AbortSignal()

    def abort(self) -> None:
        self.signal._trigger()


def _is_signal_aborted(signal: Any) -> bool:
    if signal is None:
        return False
    if hasattr(signal, "aborted"):
        return bool(signal.aborted)
    if hasattr(signal, "is_set") and callable(signal.is_set):
        return bool(signal.is_set())
    return False


def _subprocess_worker_entry(
    task_id: str,
    options: dict[str, Any],
    pipeline_options: dict[str, Any] | None,
    out_queue: mp.Queue,  # type: ignore[type-arg]
) -> None:
    def _forward_log(level: LogLevel, message: str, fields: dict[str, Any]) -> None:
        out_queue.put(
            {
                "type": "log",
                "taskId": task_id,
                "level": level,
                "message": message,
                "fields": fields,
            }
        )

    set_log_sink(_forward_log)

    async def _run() -> None:
        pipeline = LocalTranscriptionPipeline(pipeline_options)

        def on_progress(update: dict[str, Any]) -> None:
            out_queue.put({"type": "progress", "taskId": task_id, "update": update})

        opts = {**options, "onProgress": on_progress}
        res = await pipeline.transcribe(opts)
        out_queue.put(
            {
                "type": "result",
                "taskId": task_id,
                "result": {
                    "transcript": res.transcript.model_dump(exclude_none=True),
                    "discoveredSpeakers": [d.to_dict() for d in res.discoveredSpeakers],
                },
            }
        )

    try:
        asyncio.run(_run())
    except Exception as exc:
        msg = str(exc)
        if "cancel" in msg.lower():
            out_queue.put({"type": "cancelled", "taskId": task_id})
        else:
            out_queue.put({"type": "error", "taskId": task_id, "error": msg})
    finally:
        set_log_sink(None)


@dataclass
class _QueuedTask:
    task_id: str
    options: dict[str, Any]
    future: asyncio.Future[LocalTranscriptionResult]
    signal: Any = None


class LocalTranscriptionWorkerRunner:
    """Queues and runs local transcription jobs in a background worker with cancellation."""

    def __init__(
        self,
        pipeline_options: dict[str, Any] | None = None,
        *,
        use_subprocess: bool | None = None,
    ) -> None:
        self.pipeline_options = pipeline_options or {}
        if use_subprocess is None:
            env_sub = os.environ.get("OLIVE_ML_SUBPROCESS")
            self.use_subprocess = env_sub != "0"
        else:
            self.use_subprocess = use_subprocess
        self._queue: list[_QueuedTask] = []
        self._current_task: _QueuedTask | None = None
        self._current_proc: Any = None
        self._current_async_task: asyncio.Task[None] | None = None
        self._stopped = False

    @property
    def queue_length(self) -> int:
        return len(self._queue)

    @property
    def queueLength(self) -> int:
        return len(self._queue)

    @property
    def is_busy(self) -> bool:
        return self._current_task is not None

    @property
    def isBusy(self) -> bool:
        return self._current_task is not None

    async def transcribe(self, options: dict[str, Any]) -> LocalTranscriptionResult:
        signal = options.get("signal")
        if _is_signal_aborted(signal):
            raise RuntimeError("Transcription cancelled by user")

        loop = asyncio.get_running_loop()
        fut: asyncio.Future[LocalTranscriptionResult] = loop.create_future()
        task_id = str(uuid.uuid4())
        task = _QueuedTask(task_id=task_id, options=options, future=fut, signal=signal)

        def _on_abort() -> None:
            if self._current_task and self._current_task.task_id == task_id:
                if self._current_proc is not None and self._current_proc.is_alive():
                    try:
                        self._current_proc.terminate()
                    except Exception:
                        pass
                if self._current_async_task is not None and not self._current_async_task.done():
                    self._current_async_task.cancel()
                if not fut.done():
                    loop.call_soon_threadsafe(
                        self._set_cancelled_if_pending,
                        fut,
                    )
            else:
                for idx, q in enumerate(list(self._queue)):
                    if q.task_id == task_id:
                        self._queue.pop(idx)
                        if not fut.done():
                            loop.call_soon_threadsafe(
                                self._set_cancelled_if_pending,
                                fut,
                            )
                        break

        if signal is not None and hasattr(signal, "add_event_listener"):
            signal.add_event_listener("abort", _on_abort)

        if self._current_task is not None:
            on_prog = options.get("onProgress") or options.get("on_progress")
            if callable(on_prog):
                res = on_prog(
                    {
                        "stage": "queued",
                        "percent": 0,
                        "message": f"Queued for local transcription (position {len(self._queue) + 1})...",
                    }
                )
                if inspect.isawaitable(res):
                    await res
            self._queue.append(task)
        else:
            self._queue.append(task)
            self._process_next()

        return await fut

    @staticmethod
    def _set_cancelled_if_pending(fut: asyncio.Future[Any]) -> None:
        if not fut.done():
            fut.set_exception(RuntimeError("Transcription cancelled by user"))

    def _process_next(self) -> None:
        if self._current_task is not None or not self._queue or self._stopped:
            return

        next_task = self._queue.pop(0)
        if _is_signal_aborted(next_task.signal):
            if not next_task.future.done():
                next_task.future.set_exception(RuntimeError("Transcription cancelled by user"))
            self._process_next()
            return

        self._current_task = next_task
        self._current_async_task = asyncio.create_task(self._execute_task(next_task))

    def _should_run_in_subprocess(self, task: _QueuedTask) -> bool:
        if not self.use_subprocess:
            return False
        model_id = task.options.get("modelId") or (
            self.pipeline_options.get("asrConfig") or {}
        ).get("modelId")
        return model_id not in ("mock", "mock-asr")

    async def _execute_task(self, task: _QueuedTask) -> None:
        try:
            if self._should_run_in_subprocess(task):
                result = await self._run_in_subprocess(task)
            else:
                result = await self._run_in_thread_pipeline(task)
            if not task.future.done():
                task.future.set_result(result)
        except asyncio.CancelledError:
            if not task.future.done():
                task.future.set_exception(RuntimeError("Transcription cancelled by user"))
        except Exception as exc:
            if not task.future.done():
                task.future.set_exception(exc)
        finally:
            self._current_task = None
            self._current_proc = None
            self._current_async_task = None
            self._process_next()

    async def _run_in_thread_pipeline(self, task: _QueuedTask) -> LocalTranscriptionResult:
        opts = dict(task.options)
        model_id = opts.get("modelId") or (self.pipeline_options.get("asrConfig") or {}).get("modelId")
        if model_id in ("mock", "mock-asr"):
            # Add a brief cooperative yield so cancellation / HTTP concurrency tests can observe active work
            for _ in range(4):
                if _is_signal_aborted(task.signal):
                    raise RuntimeError("Transcription cancelled by user")
                await asyncio.sleep(0.02)

        pipeline = LocalTranscriptionPipeline(self.pipeline_options)
        return await pipeline.transcribe(opts)

    async def _run_in_subprocess(self, task: _QueuedTask) -> LocalTranscriptionResult:
        ctx = mp.get_context("spawn")
        out_q: mp.Queue = ctx.Queue()  # type: ignore[type-arg]
        serializable_opts = {
            k: (
                [s.model_dump() if isinstance(s, EnrolledSpeaker) else s for s in v]
                if k == "enrolledSpeakers" and isinstance(v, list)
                else v
            )
            for k, v in task.options.items()
            if k not in ("signal", "onProgress", "on_progress")
        }
        proc = ctx.Process(
            target=_subprocess_worker_entry,
            args=(task.task_id, serializable_opts, self.pipeline_options, out_q),
            daemon=True,
        )
        self._current_proc = proc
        proc.start()
        on_prog = task.options.get("onProgress") or task.options.get("on_progress")

        try:
            while True:
                if _is_signal_aborted(task.signal):
                    if proc.is_alive():
                        proc.terminate()
                    raise RuntimeError("Transcription cancelled by user")
                try:
                    msg = await asyncio.to_thread(out_q.get, True, 0.05)
                except queue.Empty as empty_err:
                    if not proc.is_alive():
                        raise RuntimeError(
                            f"Background worker exited unexpectedly with code {proc.exitcode}"
                        ) from empty_err
                    continue

                mtype = msg.get("type")
                if mtype == "log":
                    lvl = str(msg.get("level") or "info")
                    log_fn = getattr(logger, lvl, logger.info)
                    log_fn(str(msg.get("message") or ""), msg.get("fields") or {})
                elif mtype == "progress" and callable(on_prog):
                    cb_res = on_prog(msg["update"])
                    if inspect.isawaitable(cb_res):
                        await cb_res
                elif mtype == "result":
                    r = msg["result"]
                    return LocalTranscriptionResult(
                        transcript=Transcript.model_validate(r["transcript"]),
                        discoveredSpeakers=[
                            DiscoveredSpeakerVoiceprint(**d) for d in r.get("discoveredSpeakers", [])
                        ],
                    )
                elif mtype == "cancelled":
                    raise RuntimeError("Transcription cancelled by user")
                elif mtype == "error":
                    raise RuntimeError(msg.get("error") or "Local transcription worker error")
        finally:
            if proc.is_alive():
                try:
                    proc.terminate()
                except Exception:
                    pass

    def stop(self) -> None:
        self._stopped = True
        if self._current_proc is not None and self._current_proc.is_alive():
            try:
                self._current_proc.terminate()
            except Exception:
                pass
        if self._current_async_task is not None and not self._current_async_task.done():
            self._current_async_task.cancel()
        while self._queue:
            t = self._queue.pop(0)
            if not t.future.done():
                t.future.set_exception(RuntimeError("Transcription runner stopped"))
        if self._current_task is not None and not self._current_task.future.done():
            self._current_task.future.set_exception(RuntimeError("Transcription runner stopped"))
        self._current_task = None
        logger.info("Stopped LocalTranscriptionWorkerRunner")
