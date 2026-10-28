"""Client for the Olive GPU worker deployed on Modal (``modal_app/olive_gpu.py``).

``modal`` is imported lazily so the server only pays for it when the provider
is used. The worker is looked up by name (``appName`` / ``className``), spawned
as a function call, and polled so an abort signal can cancel it remotely.

Injection seam: pass ``spawn=`` with an async callable ``(audio_bytes, options)
-> handle`` where ``handle`` has ``object_id``, ``async poll(timeout) -> (done,
value)`` and ``async cancel()``. It replaces the Modal SDK and is used for tests.
"""

from __future__ import annotations

import inspect
import os
from typing import Any

from .types import ModalTranscribeResult

DEFAULT_APP_NAME = "olive-gpu"
DEFAULT_CLASS_NAME = "OliveGpu"
POLL_INTERVAL_SEC = 5.0


def _signal_aborted(signal: Any) -> bool:
    if signal is None:
        return False
    if hasattr(signal, "aborted"):
        return bool(signal.aborted)
    if hasattr(signal, "is_set") and callable(signal.is_set):
        return bool(signal.is_set())
    return False


class ModalCancelledError(RuntimeError):
    """The remote call was cancelled because the abort signal fired."""


class _ModalCallHandle:
    def __init__(self, call: Any) -> None:
        self._call = call
        self.object_id: str = str(call.object_id)

    async def poll(self, timeout: float) -> tuple[bool, Any]:
        import modal.exception

        try:
            return True, await self._call.get.aio(timeout=timeout)
        except modal.exception.FunctionTimeoutError:
            raise
        except (TimeoutError, modal.exception.TimeoutError):
            # A poll with no output yet raises the builtin TimeoutError (the
            # call may still be queued for a GPU); only FunctionTimeoutError
            # means the worker itself ran out of time.
            return False, None

    async def cancel(self) -> None:
        await self._call.cancel.aio()


class ModalClient:
    def __init__(self, options: dict[str, Any] | None = None, **kwargs: Any) -> None:
        opts = {**(options or {}), **kwargs}
        self.token_id: str = str(
            opts.get("tokenId") if "tokenId" in opts else os.environ.get("MODAL_TOKEN_ID") or ""
        )
        self.token_secret: str = str(
            opts.get("tokenSecret") if "tokenSecret" in opts else os.environ.get("MODAL_TOKEN_SECRET") or ""
        )
        self.app_name: str = str(opts.get("appName") or DEFAULT_APP_NAME)
        self.class_name: str = str(opts.get("className") or DEFAULT_CLASS_NAME)
        self.poll_interval: float = float(opts.get("pollIntervalSec") or POLL_INTERVAL_SEC)
        self._spawn: Any = opts.get("spawn")

    def set_credentials(
        self, token_id: str | None, token_secret: str | None, app_name: str | None = None
    ) -> None:
        """Updates credentials at runtime (e.g. after a Settings-UI save)."""
        self.token_id = str(token_id or "")
        self.token_secret = str(token_secret or "")
        if app_name:
            self.app_name = str(app_name)

    @property
    def is_configured(self) -> bool:
        return self._spawn is not None or bool(self.token_id.strip() and self.token_secret.strip())

    async def _default_spawn(self, audio_bytes: bytes, options: dict[str, Any]) -> _ModalCallHandle:
        import modal

        client = await modal.Client.from_credentials.aio(self.token_id, self.token_secret)
        worker_cls = modal.Cls.from_name(self.app_name, self.class_name, client=client)
        call = await worker_cls().transcribe.spawn.aio(audio_bytes, options)
        return _ModalCallHandle(call)

    async def transcribe(
        self,
        audio_bytes: bytes,
        options: dict[str, Any] | None = None,
        *,
        signal: Any = None,
        on_spawned: Any = None,
    ) -> ModalTranscribeResult:
        """Runs the remote pipeline; returns the worker result plus ``functionCallId``."""
        if not self.is_configured:
            raise RuntimeError("Modal token is not configured")
        if not audio_bytes:
            raise ValueError("No audio provided for Modal transcription")
        spawn = self._spawn or self._default_spawn
        handle = await spawn(bytes(audio_bytes), dict(options or {}))
        call_id = str(handle.object_id)
        if callable(on_spawned):
            res = on_spawned(call_id)
            if inspect.isawaitable(res):
                await res
        try:
            while True:
                if _signal_aborted(signal):
                    raise ModalCancelledError("Transcription was cancelled.")
                done, value = await handle.poll(self.poll_interval)
                if done:
                    result: ModalTranscribeResult = dict(value or {})  # type: ignore[assignment]
                    result["functionCallId"] = call_id
                    return result
        except BaseException:
            # Never leave an orphaned call queued or running (and billing) on Modal.
            try:
                await handle.cancel()
            except Exception:
                pass
            raise
