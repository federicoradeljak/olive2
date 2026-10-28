"""ModalClient polling / cancellation and SDK handle adapter (no network)."""

from __future__ import annotations

from typing import Any

import modal.exception
import pytest

from olive.ml import AbortController
from olive.providers.modal import ModalCancelledError, ModalClient
from olive.providers.modal.client import _ModalCallHandle


class _Handle:
    object_id = "fc-9"

    def __init__(self, polls_before_done: int) -> None:
        self.polls_left = polls_before_done
        self.cancelled = False

    async def poll(self, timeout: float) -> tuple[bool, Any]:
        if self.polls_left:
            self.polls_left -= 1
            return False, None
        return True, {"transcript": {"segments": []}}

    async def cancel(self) -> None:
        self.cancelled = True


async def test_unconfigured_client_refuses() -> None:
    client = ModalClient({"tokenId": "", "tokenSecret": ""})
    with pytest.raises(RuntimeError, match="not configured"):
        await client.transcribe(b"audio")


async def test_transcribe_polls_until_done_and_reports_call_id() -> None:
    handle = _Handle(polls_before_done=3)
    seen: list[str] = []

    async def _spawn(_audio: bytes, _opts: dict[str, Any]) -> _Handle:
        return handle

    client = ModalClient({"spawn": _spawn})
    result = await client.transcribe(b"audio", {"asrModel": "cohere"}, on_spawned=seen.append)
    assert result["functionCallId"] == "fc-9"
    assert seen == ["fc-9"]
    assert handle.polls_left == 0


async def test_abort_cancels_remote_call() -> None:
    handle = _Handle(polls_before_done=1_000)
    controller = AbortController()

    async def _spawn(_audio: bytes, _opts: dict[str, Any]) -> _Handle:
        controller.abort()
        return handle

    client = ModalClient({"spawn": _spawn})
    with pytest.raises(ModalCancelledError):
        await client.transcribe(b"audio", signal=controller.signal)
    assert handle.cancelled is True


class _SdkGet:
    def __init__(self, exc: Exception | None) -> None:
        self.exc = exc

    async def aio(self, timeout: float | None = None) -> Any:
        if self.exc is not None:
            raise self.exc
        return {"ok": True}


async def test_sdk_handle_maps_poll_timeout_but_not_function_timeout() -> None:
    def _call(exc: Exception | None) -> Any:
        return type("Call", (), {"object_id": "fc-1", "get": _SdkGet(exc)})()

    assert await _ModalCallHandle(_call(None)).poll(1) == (True, {"ok": True})
    assert await _ModalCallHandle(_call(modal.exception.TimeoutError("poll"))).poll(1) == (False, None)
    # The SDK signals "no output yet" (e.g. still queued for a GPU) with the builtin.
    assert await _ModalCallHandle(_call(TimeoutError())).poll(1) == (False, None)
    with pytest.raises(modal.exception.FunctionTimeoutError):
        await _ModalCallHandle(_call(modal.exception.FunctionTimeoutError("worker"))).poll(1)


async def test_poll_failure_cancels_remote_call() -> None:
    class _Failing(_Handle):
        async def poll(self, timeout: float) -> tuple[bool, Any]:
            raise RuntimeError("worker crashed")

    handle = _Failing(0)

    async def _spawn(_audio: bytes, _opts: dict[str, Any]) -> _Handle:
        return handle

    with pytest.raises(RuntimeError, match="worker crashed"):
        await ModalClient({"spawn": _spawn}).transcribe(b"audio")
    assert handle.cancelled is True
