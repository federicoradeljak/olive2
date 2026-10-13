"""DBOS-backed worker runner for local transcription with progress and cancellation."""

from __future__ import annotations

import inspect
import threading
import uuid
from collections.abc import Callable
from typing import Any

from ..logging_db import logger
from ..workflows.runtime import ensure_dbos_launched_async
from ..workflows.transcription_workflow import run_staged_local_transcription
from .protocols import LocalTranscriptionResult


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


class LocalTranscriptionWorkerRunner:
    """Dispatches local transcription jobs onto DBOS stage queues with cancellation."""

    def __init__(
        self,
        pipeline_options: dict[str, Any] | None = None,
        *,
        use_subprocess: bool | None = None,
        config_dir: str | None = None,
        meetings_dir: str | None = None,
    ) -> None:
        self.pipeline_options = pipeline_options or {}
        self.use_subprocess = False if use_subprocess is None else bool(use_subprocess)
        self.config_dir = config_dir or self.pipeline_options.get("configDir")
        self.meetings_dir = meetings_dir or self.pipeline_options.get("meetingsDir")
        self._active_controllers: dict[str, AbortController] = {}
        self._stopped = False

    @property
    def queue_length(self) -> int:
        return max(0, len(self._active_controllers) - 1)

    @property
    def queueLength(self) -> int:
        return self.queue_length

    @property
    def is_busy(self) -> bool:
        return len(self._active_controllers) > 0

    @property
    def isBusy(self) -> bool:
        return self.is_busy

    async def transcribe(self, options: dict[str, Any]) -> LocalTranscriptionResult:
        if self._stopped:
            raise RuntimeError("Transcription runner stopped")

        ext_signal = options.get("signal")
        if _is_signal_aborted(ext_signal):
            raise RuntimeError("Transcription cancelled by user")

        await ensure_dbos_launched_async(
            config_dir=options.get("configDir") or self.config_dir,
            meetings_dir=options.get("meetingsDir") or self.meetings_dir,
        )

        run_id = str(uuid.uuid4())
        controller = AbortController()
        if ext_signal is not None and hasattr(ext_signal, "add_event_listener"):
            ext_signal.add_event_listener("abort", controller.abort)

        if self._active_controllers:
            on_prog = options.get("onProgress") or options.get("on_progress")
            if callable(on_prog):
                res = on_prog(
                    {
                        "stage": "queued",
                        "percent": 0,
                        "message": f"Queued for local transcription (position {len(self._active_controllers)})...",
                    }
                )
                if inspect.isawaitable(res):
                    await res

        self._active_controllers[run_id] = controller
        try:
            merged_options = {**options, "signal": controller.signal}
            return await run_staged_local_transcription(
                merged_options,
                pipeline_options=self.pipeline_options,
                db=options.get("db"),
                now_fn=options.get("now_fn"),
                workflow_id=options.get("workflow_id"),
            )
        finally:
            self._active_controllers.pop(run_id, None)

    def stop(self) -> None:
        self._stopped = True
        for controller in list(self._active_controllers.values()):
            controller.abort()
        self._active_controllers.clear()
        logger.info("Stopped LocalTranscriptionWorkerRunner")
