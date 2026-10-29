import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import type { MeetingUsageResponse, UsageSummary } from "../api/types.ts";
import { formatDate } from "../lib/common";

export function formatLogTimestamp(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (n: number, z = 2) => String(n).padStart(z, "0");
  const yr = d.getFullYear();
  const mo = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hr = pad(d.getHours());
  const min = pad(d.getMinutes());
  const sec = pad(d.getSeconds());
  const ms = pad(d.getMilliseconds(), 3);
  return `${yr}-${mo}-${day} ${hr}:${min}:${sec}.${ms}`;
}

export function formatUsageUsd(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function formatUsageTokens(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${value}`;
}

export function formatUsageHours(audioSeconds: number | null | undefined): string {
  if (audioSeconds === null || audioSeconds === undefined) return "—";
  const hours = audioSeconds / 3600;
  if (hours >= 10) return `${hours.toFixed(1)}h`;
  if (hours >= 1) return `${hours.toFixed(2)}h`;
  return `${Math.round(audioSeconds / 60)}m`;
}

export function UsageView({ onSelectMeeting }: { onSelectMeeting: (id: string) => void }): ReactElement {
  const currentMonth = new Date().toISOString().slice(0, 7);
  const [month, setMonth] = useState(currentMonth);
  const [showAllTime, setShowAllTime] = useState(false);
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const params = showAllTime ? "period=all" : `month=${encodeURIComponent(month)}`;
        const res = await fetch(`/api/usage/summary?${params}`);
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error || `Request failed (${res.status})`);
        }
        const data = (await res.json()) as UsageSummary;
        if (!cancelled) setSummary(data);
      } catch (exc) {
        if (!cancelled) setError(exc instanceof Error ? exc.message : "Failed to load usage");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [month, showAllTime]);

  const rates = summary?.rates?.transcriptionUsdPerHour;
  const byProvider = summary?.byProvider ?? [];
  const byMeeting = summary?.byMeeting ?? [];
  const rateNote = rates
    ? Object.entries(rates)
        .filter(([, v]) => (v ?? 0) > 0)
        .map(([k, v]) => `${k} $${Number(v).toFixed(2)}/hr`)
        .join(" · ")
    : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-base-content">API Usage & Spend</h1>
          <p className="text-sm text-base-content/70">
            Estimated cloud spend: transcription billed per hour of audio, LLM billed per token.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="month"
            value={month}
            max={currentMonth}
            disabled={showAllTime}
            onChange={(e) => {
              if (e.target.value) {
                setMonth(e.target.value);
                setShowAllTime(false);
              }
            }}
            aria-label="Usage month"
            className="input input-md w-full py-1.5 text-base-content disabled:opacity-50"
          />
          <button
            type="button"
            onClick={() => setShowAllTime((v) => !v)}
            className={`min-h-[44px] rounded-lg border px-3 py-1.5 text-sm font-medium transition sm:min-h-0 ${
              showAllTime
                ? "border-primary/50 bg-primary/10 text-primary"
                : "border-base-300 text-base-content hover:border-base-300 hover:text-base-content"
            }`}
          >
            All time
          </button>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-base-content/70">Loading usage…</p>
      ) : error ? (
        <p className="text-sm text-error">{error}</p>
      ) : summary ? (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-base-300 bg-base-200/60 p-4">
              <div className="text-xs font-medium uppercase tracking-wide text-base-content/50">Total spend</div>
              <div className="mt-1 text-2xl font-bold text-base-content">{formatUsageUsd(summary.totalCostUsd)}</div>
              <div className="mt-1 text-xs text-base-content/50">{summary.eventCount} billed events</div>
            </div>
            <div className="rounded-xl border border-base-300 bg-base-200/60 p-4">
              <div className="text-xs font-medium uppercase tracking-wide text-base-content/50">Transcription</div>
              <div className="mt-1 text-2xl font-bold text-base-content">{formatUsageUsd(summary.transcriptionCostUsd)}</div>
              <div className="mt-1 text-xs text-base-content/50">{formatUsageHours(summary.audioSeconds)} of audio</div>
            </div>
            <div className="rounded-xl border border-base-300 bg-base-200/60 p-4">
              <div className="text-xs font-medium uppercase tracking-wide text-base-content/50">LLM</div>
              <div className="mt-1 text-2xl font-bold text-base-content">{formatUsageUsd(summary.llmCostUsd)}</div>
              <div className="mt-1 text-xs text-base-content/50">
                {formatUsageTokens(summary.totalTokens)} tokens ({formatUsageTokens(summary.inputTokens)} in /{" "}
                {formatUsageTokens(summary.outputTokens)} out)
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-base-300 bg-base-200/60 p-4">
            <h2 className="text-sm font-semibold text-base-content">By provider</h2>
            {byProvider.length === 0 ? (
              <p className="mt-2 text-sm text-base-content/50">No cloud usage in this period. Local transcription is free.</p>
            ) : (
              <>
              <div className="mt-2 hidden overflow-x-auto sm:block">
                <table className="table table-sm w-full min-w-[560px] text-left">
                  <thead>
                    <tr className="text-xs uppercase tracking-wide text-base-content/50">
                      <th className="py-1.5 pr-3 font-medium">Provider</th>
                      <th className="py-1.5 pr-3 font-medium">Audio</th>
                      <th className="py-1.5 pr-3 font-medium">Tokens</th>
                      <th className="py-1.5 pr-3 text-right font-medium">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byProvider.map((p) => (
                      <tr key={p.provider} className="border-t border-base-300/80">
                        <td className="py-2 pr-3">
                          <span className="font-medium text-base-content">{p.provider}</span>
                          <span className="ml-2 text-xs text-base-content/50">{(p.kinds ?? []).join(", ")}</span>
                        </td>
                        <td className="py-2 pr-3 text-base-content">{formatUsageHours(p.audioSeconds)}</td>
                        <td className="py-2 pr-3 text-base-content">{formatUsageTokens(p.totalTokens)}</td>
                        <td className="py-2 text-right font-semibold text-base-content">{formatUsageUsd(p.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul className="mt-2 space-y-2 sm:hidden">
                {byProvider.map((p) => (
                  <li key={p.provider} className="rounded-lg border border-base-300 bg-base-100/60 p-3">
                    <div>
                      <span className="font-medium text-base-content">{p.provider}</span>
                      <span className="ml-2 text-xs text-base-content/50">{(p.kinds ?? []).join(", ")}</span>
                    </div>
                    <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
                      <div>
                        <dt className="text-base-content/50">Audio</dt>
                        <dd className="text-base-content">{formatUsageHours(p.audioSeconds)}</dd>
                      </div>
                      <div>
                        <dt className="text-base-content/50">Tokens</dt>
                        <dd className="text-base-content">{formatUsageTokens(p.totalTokens)}</dd>
                      </div>
                      <div className="text-right">
                        <dt className="text-base-content/50">Cost</dt>
                        <dd className="font-semibold text-base-content">{formatUsageUsd(p.costUsd)}</dd>
                      </div>
                    </dl>
                  </li>
                ))}
              </ul>
              </>
            )}
          </div>

          <div className="rounded-xl border border-base-300 bg-base-200/60 p-4">
            <h2 className="text-sm font-semibold text-base-content">Per meeting</h2>
            {byMeeting.length === 0 ? (
              <p className="mt-2 text-sm text-base-content/50">No per-meeting usage in this period.</p>
            ) : (
              <>
              <div className="mt-2 hidden overflow-x-auto sm:block">
                <table className="table table-sm w-full min-w-[640px] text-left">
                  <thead>
                    <tr className="text-xs uppercase tracking-wide text-base-content/50">
                      <th className="py-1.5 pr-3 font-medium">Meeting</th>
                      <th className="py-1.5 pr-3 font-medium">Audio</th>
                      <th className="py-1.5 pr-3 font-medium">Transcription</th>
                      <th className="py-1.5 pr-3 font-medium">LLM</th>
                      <th className="py-1.5 text-right font-medium">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byMeeting.map((m) => (
                      <tr key={m.meetingId} className="border-t border-base-300/80">
                        <td className="py-2 pr-3">
                          <button
                            type="button"
                            onClick={() => onSelectMeeting(m.meetingId)}
                            className="font-medium text-primary hover:text-primary hover:underline text-left"
                          >
                            {m.meetingTitle || "Untitled meeting"}
                          </button>
                          {m.meetingStartTime ? (
                            <div className="text-xs text-base-content/50">{formatDate(m.meetingStartTime)}</div>
                          ) : null}
                        </td>
                        <td className="py-2 pr-3 text-base-content">{formatUsageHours(m.audioSeconds)}</td>
                        <td className="py-2 pr-3 text-base-content">{formatUsageUsd(m.transcriptionCostUsd)}</td>
                        <td className="py-2 pr-3 text-base-content">
                          {formatUsageUsd(m.llmCostUsd)}
                          <span className="ml-1 text-xs text-base-content/50">({formatUsageTokens(m.totalTokens)})</span>
                        </td>
                        <td className="py-2 text-right font-semibold text-base-content">
                          {formatUsageUsd(m.totalCostUsd)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul className="mt-2 space-y-2 sm:hidden">
                {byMeeting.map((m) => (
                  <li key={m.meetingId} className="rounded-lg border border-base-300 bg-base-100/60 p-3">
                    <button
                      type="button"
                      onClick={() => onSelectMeeting(m.meetingId)}
                      className="flex min-h-[44px] w-full flex-col justify-center text-left"
                    >
                      <span className="font-medium text-primary">{m.meetingTitle || "Untitled meeting"}</span>
                      {m.meetingStartTime ? (
                        <span className="text-xs text-base-content/50">{formatDate(m.meetingStartTime)}</span>
                      ) : null}
                    </button>
                    <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                      <div>
                        <dt className="text-base-content/50">Audio</dt>
                        <dd className="text-base-content">{formatUsageHours(m.audioSeconds)}</dd>
                      </div>
                      <div>
                        <dt className="text-base-content/50">Transcription</dt>
                        <dd className="text-base-content">{formatUsageUsd(m.transcriptionCostUsd)}</dd>
                      </div>
                      <div>
                        <dt className="text-base-content/50">LLM</dt>
                        <dd className="text-base-content">
                          {formatUsageUsd(m.llmCostUsd)}
                          <span className="ml-1 text-base-content/50">({formatUsageTokens(m.totalTokens)})</span>
                        </dd>
                      </div>
                      <div>
                        <dt className="text-base-content/50">Total</dt>
                        <dd className="font-semibold text-base-content">{formatUsageUsd(m.totalCostUsd)}</dd>
                      </div>
                    </dl>
                  </li>
                ))}
              </ul>
              </>
            )}
          </div>

          <p className="text-xs text-base-content/50">
            Estimates, not invoices{rateNote ? `: transcription at ${rateNote}` : ""}; LLM per-token rates vary by
            model (see the AI model picker for per-model pricing). Summary LLM usage is tracked from this update
            onward — older summaries predate usage tracking, while transcription and chat history were backfilled.
          </p>
        </>
      ) : null}
    </div>
  );
}

export function MeetingUsageLine({ meetingId }: { meetingId: string }): ReactElement | null {
  const [usage, setUsage] = useState<MeetingUsageResponse | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/meetings/${meetingId}/usage`);
        if (res.ok) {
          const data = (await res.json()) as MeetingUsageResponse;
          if (!cancelled) setUsage(data);
        }
      } catch {
        // Usage is informational; never break the meeting view.
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [meetingId]);
  if (!usage || usage.eventCount === 0) return null;
  return (
    <div className="mt-2 text-xs sm:text-sm text-base-content/70" title="Estimated cloud spend for this meeting (transcription billed per audio hour, LLM per token).">
      Cost ≈ <span className="font-semibold text-base-content">{formatUsageUsd(usage.totalCostUsd)}</span>
      <span className="text-base-content/50">
        {" "}(transcription {formatUsageUsd(usage.transcriptionCostUsd)} · LLM {formatUsageUsd(usage.llmCostUsd)})
      </span>
    </div>
  );
}
