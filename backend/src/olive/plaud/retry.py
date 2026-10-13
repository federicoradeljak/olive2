"""Rate-limit aware retry helper for Olive's Plaud requests (port of packages/server/src/plaud/retry.ts)."""

from __future__ import annotations

import asyncio
import email.utils
import inspect
import random
import re
import time
from collections.abc import Callable
from typing import Any, TypeVar

from .sdk import RateLimitError

T = TypeVar("T")

DEFAULT_PLAUD_RETRY_MAX = 4
DEFAULT_PLAUD_RETRY_BASE_MS = 1_000
DEFAULT_PLAUD_RETRY_MAX_DELAY_MS = 60_000


def resolve_retry_policy(options: dict[str, Any] | None = None) -> dict[str, Any]:
    opts = options or {}
    return {
        "maxRetries": int(
            opts["maxRetries"]
            if opts.get("maxRetries") is not None
            else DEFAULT_PLAUD_RETRY_MAX
        ),
        "baseDelayMs": int(
            opts["baseDelayMs"]
            if opts.get("baseDelayMs") is not None
            else DEFAULT_PLAUD_RETRY_BASE_MS
        ),
        "maxDelayMs": int(
            opts["maxDelayMs"]
            if opts.get("maxDelayMs") is not None
            else DEFAULT_PLAUD_RETRY_MAX_DELAY_MS
        ),
        "random": opts.get("random") or random.random,
    }


resolveRetryPolicy = resolve_retry_policy


def _numeric_property(error: Any, key: str) -> float | None:
    val = getattr(error, key, None)
    if val is None and isinstance(error, dict):
        val = error.get(key)
    if isinstance(val, (int, float)) and not isinstance(val, bool):
        return float(val)
    return None


def is_rate_limit_error(error: Any) -> bool:
    if isinstance(error, RateLimitError):
        return True
    if not isinstance(error, BaseException):
        return False
    if _numeric_property(error, "retryAfterMs") is not None or _numeric_property(error, "retry_after_ms") is not None:
        return True
    if _numeric_property(error, "status") == 429 or _numeric_property(error, "statusCode") == 429:
        return True
    return bool(re.search(r"rate.?limit|too many requests|\b429\b", str(error), re.I))


isRateLimitError = is_rate_limit_error


def retry_after_ms_from(error: Any) -> int | None:
    val = _numeric_property(error, "retryAfterMs")
    if val is None:
        val = _numeric_property(error, "retry_after_ms")
    if val is not None and val >= 0:
        return int(round(val))
    return None


retryAfterMsFrom = retry_after_ms_from


def parse_retry_after_ms(value: str | None) -> int | None:
    if not value:
        return None
    try:
        secs = float(value)
        if secs >= 0:
            return int(round(secs * 1000))
        return None
    except ValueError:
        pass
    try:
        dt = email.utils.parsedate_to_datetime(value)
        return max(0, int(round(dt.timestamp() * 1000 - time.time() * 1000)))
    except Exception:
        return None


parseRetryAfterMs = parse_retry_after_ms


def compute_retry_delay_ms(
    error: Any,
    attempt: int,
    policy: dict[str, Any],
) -> int:
    max_delay_ms = int(policy["maxDelayMs"])
    base_delay_ms = int(policy["baseDelayMs"])
    rng: Callable[[], float] = policy["random"]

    server_delay = retry_after_ms_from(error)
    if server_delay is not None:
        return min(server_delay, max_delay_ms)

    exponential = base_delay_ms * (2**attempt)
    jitter = 1.0 - float(rng()) * 0.25
    return min(max_delay_ms, max(0, int(round(exponential * jitter))))


computeRetryDelayMs = compute_retry_delay_ms


async def with_rate_limit_retry(
    operation: Callable[[], Any],
    options: dict[str, Any] | None = None,
) -> Any:
    opts = options or {}
    policy = resolve_retry_policy(opts)
    sleep_fn = opts.get("sleep")
    signal = opts.get("signal")
    on_retry = opts.get("onRetry") or opts.get("on_retry")

    attempt = 0
    while True:
        try:
            res = operation()
            if inspect.isawaitable(res):
                return await res
            return res
        except Exception as error:
            is_set_fn = getattr(signal, "is_set", None)
            if getattr(signal, "aborted", False) or (callable(is_set_fn) and is_set_fn()):
                raise RuntimeError("Plaud request aborted") from error
            if attempt >= int(policy["maxRetries"]) or not is_rate_limit_error(error):
                raise
            delay_ms = compute_retry_delay_ms(error, attempt, policy)
            attempt += 1
            if callable(on_retry):
                on_retry(
                    {
                        "attempt": attempt,
                        "maxRetries": policy["maxRetries"],
                        "delayMs": delay_ms,
                        "error": error,
                    }
                )
            if callable(sleep_fn):
                s_res = sleep_fn(delay_ms)
                if inspect.isawaitable(s_res):
                    await s_res
            else:
                await asyncio.sleep(max(0.0, delay_ms / 1000.0))


withRateLimitRetry = with_rate_limit_retry


def rate_limit_error_from_response(response: Any) -> RateLimitError:
    status = getattr(response, "status", None) or getattr(response, "status_code", 429)
    headers = getattr(response, "headers", None) or {}
    retry_hdr = headers.get("retry-after") if hasattr(headers, "get") else None
    return RateLimitError(
        f"Plaud request rate limited (HTTP {status})",
        parse_retry_after_ms(retry_hdr),
    )


rateLimitErrorFromResponse = rate_limit_error_from_response
