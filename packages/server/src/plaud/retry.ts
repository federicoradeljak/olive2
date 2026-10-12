/**
 * Rate-limit aware retry helper for Olive's Plaud requests.
 *
 * `@mcowger/plaud-client` retries 5xx/network failures on its own, but it treats
 * HTTP 429 as terminal: it throws `RateLimitError` (carrying the server's
 * `Retry-After` delay) without ever backing off. Olive also downloads presigned
 * audio URLs directly, bypassing the client entirely. This module adds the
 * missing exponential backoff for those 429s so a throttled poll cycle retries
 * instead of immediately marking the meeting as errored.
 */

import { RateLimitError } from "@mcowger/plaud-client";

export interface PlaudRetryInfo {
  attempt: number;
  maxRetries: number;
  delayMs: number;
  error: unknown;
}

export interface PlaudRetryOptions {
  /** Retries after the initial attempt. Defaults to 4. */
  maxRetries?: number;
  /** Base for the exponential backoff. Defaults to 1000ms. */
  baseDelayMs?: number;
  /** Upper bound applied to every delay (including server `Retry-After`). Defaults to 60000ms. */
  maxDelayMs?: number;
  /** Stops retrying and rejects the pending backoff sleep when aborted. */
  signal?: AbortSignal;
  /** Observer invoked before each backoff sleep. */
  onRetry?: (info: PlaudRetryInfo) => void;
  /** Injectable sleep/random for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface ResolvedPlaudRetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  random: () => number;
}

export const DEFAULT_PLAUD_RETRY_MAX = 4;
export const DEFAULT_PLAUD_RETRY_BASE_MS = 1_000;
export const DEFAULT_PLAUD_RETRY_MAX_DELAY_MS = 60_000;

export function resolveRetryPolicy(options: PlaudRetryOptions = {}): ResolvedPlaudRetryPolicy {
  return {
    maxRetries: options.maxRetries ?? DEFAULT_PLAUD_RETRY_MAX,
    baseDelayMs: options.baseDelayMs ?? DEFAULT_PLAUD_RETRY_BASE_MS,
    maxDelayMs: options.maxDelayMs ?? DEFAULT_PLAUD_RETRY_MAX_DELAY_MS,
    random: options.random ?? Math.random
  };
}

function numericProperty(error: unknown, key: string): number | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const value = (error as unknown as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** True for the Plaud client's `RateLimitError` and anything else that looks like a 429. */
export function isRateLimitError(error: unknown): boolean {
  if (error instanceof RateLimitError) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  if (numericProperty(error, "retryAfterMs") !== undefined) {
    return true;
  }
  if (numericProperty(error, "status") === 429 || numericProperty(error, "statusCode") === 429) {
    return true;
  }
  return /rate.?limit|too many requests|\b429\b/i.test(error.message);
}

/** Server-requested delay in milliseconds, if the error carries one. */
export function retryAfterMsFrom(error: unknown): number | undefined {
  const value = numericProperty(error, "retryAfterMs");
  return value !== undefined && value >= 0 ? value : undefined;
}

/** Parse an HTTP `Retry-After` header (seconds or HTTP-date) into milliseconds. */
export function parseRetryAfterMs(value: string | null | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number.parseFloat(value);
  if (Number.isFinite(seconds)) {
    return seconds >= 0 ? Math.round(seconds * 1000) : undefined;
  }
  const dateMs = Date.parse(value);
  if (Number.isNaN(dateMs)) {
    return undefined;
  }
  return Math.max(0, dateMs - Date.now());
}

/**
 * Delay before retry number `attempt` (0-indexed). Honors the server's
 * `Retry-After` when present, otherwise uses exponential backoff with jitter.
 * Every result is clamped to the policy's `maxDelayMs`.
 */
export function computeRetryDelayMs(
  error: unknown,
  attempt: number,
  policy: ResolvedPlaudRetryPolicy
): number {
  const serverDelay = retryAfterMsFrom(error);
  if (serverDelay !== undefined) {
    return Math.min(serverDelay, policy.maxDelayMs);
  }
  const exponential = policy.baseDelayMs * 2 ** attempt;
  const jitter = 1 - policy.random() * 0.25;
  return Math.min(policy.maxDelayMs, Math.max(0, Math.round(exponential * jitter)));
}

function abortError(): Error {
  const error = new Error("Plaud request aborted");
  error.name = "AbortError";
  return error;
}

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortError());
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run `operation`, retrying with backoff while it fails with a rate-limit error.
 * Non-rate-limit errors and exhausted retries propagate unchanged.
 */
export async function withRateLimitRetry<T>(
  operation: () => Promise<T>,
  options: PlaudRetryOptions = {}
): Promise<T> {
  const policy = resolveRetryPolicy(options);
  const sleep = options.sleep ?? ((ms) => sleepWithSignal(ms, options.signal));

  let attempt = 0;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (options.signal?.aborted) {
        throw abortError();
      }
      if (attempt >= policy.maxRetries || !isRateLimitError(error)) {
        throw error;
      }
      const delayMs = computeRetryDelayMs(error, attempt, policy);
      attempt += 1;
      options.onRetry?.({ attempt, maxRetries: policy.maxRetries, delayMs, error });
      await sleep(delayMs);
    }
  }
}

/** Build a `RateLimitError` carrying the response's `Retry-After`, for non-client fetches. */
export function rateLimitErrorFromResponse(response: Response): RateLimitError {
  return new RateLimitError(
    `Plaud request rate limited (HTTP ${response.status})`,
    parseRetryAfterMs(response.headers.get("retry-after"))
  );
}
