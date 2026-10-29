import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import type { MeetingUsageResponse, UsageMeetingBreakdown, UsageProviderBreakdown, UsageSummary } from "../api/types.ts";

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

type UsagePeriod = "this" | "last" | "6m" | "all" | "custom";

const PERIODS: Array<{ key: Exclude<UsagePeriod, "custom">; label: string }> = [
  { key: "this", label: "This month" },
  { key: "last", label: "Last month" },
  { key: "6m", label: "6 months" },
  { key: "all", label: "All time" },
];

/* Second chart series: a muted olive that reads in both themes. */
const LLM_SERIES = "color-mix(in oklab, var(--color-primary) 45%, var(--color-base-100))";

/* Months are UTC `YYYY-MM`, matching the backend's month bounds. */
function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

function monthName(month: string, style: "short" | "long" = "short", withYear = false): string {
  const [y, m] = month.split("-").map(Number);
  return new Intl.DateTimeFormat(undefined, { month: style, year: withYear ? "numeric" : undefined, timeZone: "UTC" }).format(
    new Date(Date.UTC(y, m - 1, 1)),
  );
}

async function fetchUsage(params: string): Promise<UsageSummary> {
  const res = await fetch(`/api/usage/summary?${params}`);
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return (await res.json()) as UsageSummary;
}

/* Merges per-month summaries into one (used for the 6-month period). */
function combineSummaries(parts: UsageSummary[]): UsageSummary {
  const providers = new Map<string, UsageProviderBreakdown>();
  const meetings = new Map<string, UsageMeetingBreakdown>();
  const total: UsageSummary = {
    startAt: null,
    endAt: null,
    audioSeconds: 0,
    transcriptionCostUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    llmCostUsd: 0,
    totalCostUsd: 0,
    eventCount: 0,
    byProvider: [],
    byMeeting: [],
    rates: null,
  };
  for (const s of parts) {
    if (s.startAt != null) total.startAt = total.startAt == null ? s.startAt : Math.min(total.startAt, s.startAt);
    if (s.endAt != null) total.endAt = total.endAt == null ? s.endAt : Math.max(total.endAt, s.endAt);
    total.audioSeconds += s.audioSeconds ?? 0;
    total.transcriptionCostUsd += s.transcriptionCostUsd ?? 0;
    total.inputTokens += s.inputTokens ?? 0;
    total.outputTokens += s.outputTokens ?? 0;
    total.totalTokens += s.totalTokens ?? 0;
    total.llmCostUsd += s.llmCostUsd ?? 0;
    total.totalCostUsd += s.totalCostUsd ?? 0;
    total.eventCount += s.eventCount ?? 0;
    total.rates = s.rates ?? total.rates;
    for (const p of s.byProvider ?? []) {
      const cur = providers.get(p.provider);
      if (!cur) {
        providers.set(p.provider, { ...p, kinds: [...(p.kinds ?? [])] });
        continue;
      }
      cur.kinds = Array.from(new Set([...(cur.kinds ?? []), ...(p.kinds ?? [])])).sort();
      cur.audioSeconds += p.audioSeconds ?? 0;
      cur.inputTokens += p.inputTokens ?? 0;
      cur.outputTokens += p.outputTokens ?? 0;
      cur.totalTokens += p.totalTokens ?? 0;
      cur.eventCount += p.eventCount ?? 0;
      cur.costUsd += p.costUsd ?? 0;
    }
    for (const m of s.byMeeting ?? []) {
      const cur = meetings.get(m.meetingId);
      if (!cur) {
        meetings.set(m.meetingId, { ...m });
        continue;
      }
      cur.audioSeconds += m.audioSeconds ?? 0;
      cur.transcriptionCostUsd += m.transcriptionCostUsd ?? 0;
      cur.inputTokens += m.inputTokens ?? 0;
      cur.outputTokens += m.outputTokens ?? 0;
      cur.totalTokens += m.totalTokens ?? 0;
      cur.llmCostUsd += m.llmCostUsd ?? 0;
      cur.totalCostUsd += m.totalCostUsd ?? 0;
      cur.eventCount += m.eventCount ?? 0;
    }
  }
  total.byProvider = [...providers.values()].sort((a, b) => b.costUsd - a.costUsd);
  total.byMeeting = [...meetings.values()].sort((a, b) => b.totalCostUsd - a.totalCostUsd);
  return total;
}

function percentChange(current: number, previous: number): string | null {
  if (!(previous > 0)) return null;
  const pct = Math.round(((current - previous) / previous) * 100);
  return `${pct > 0 ? "+" : ""}${pct}%`;
}

function StatCard({ label, value, sub }: { label: string; value: string; sub: string }): ReactElement {
  return (
    <div className="flex flex-col gap-1 rounded-box border border-base-300 p-4 sm:p-[18px]">
      <span className="text-[13px] text-base-content/60">{label}</span>
      <span className="text-3xl font-bold tracking-tight tabular-nums">{value}</span>
      <span className="text-[13px] text-base-content/60">{sub}</span>
    </div>
  );
}

function SpendChart({
  months,
  data,
  highlighted,
}: {
  months: string[];
  data: Record<string, UsageSummary | undefined>;
  highlighted: Set<string>;
}): ReactElement {
  const rows = months.map((m) => {
    const s = data[m];
    return { month: m, tx: s?.transcriptionCostUsd ?? 0, llm: s?.llmCostUsd ?? 0, total: s?.totalCostUsd ?? 0, loaded: !!s };
  });
  const max = Math.max(...rows.map((r) => r.total), 0);
  const peak = rows.reduce((best, r) => (r.total > best.total ? r : best), rows[0]);
  const sum = rows.reduce((acc, r) => acc + r.total, 0);
  const dense = months.length > 6;
  const summary =
    max > 0
      ? `Spend per month, ${monthName(months[0], "long", true)} to ${monthName(months[months.length - 1], "long", true)}: ${formatUsageUsd(sum)} in total. Highest is ${monthName(peak.month, "long", true)} at ${formatUsageUsd(peak.total)}.`
      : `No spend between ${monthName(months[0], "long", true)} and ${monthName(months[months.length - 1], "long", true)}.`;
  const cols = { gridTemplateColumns: `repeat(${months.length}, minmax(0, 1fr))` };

  return (
    <section className="flex flex-col gap-3.5 rounded-box border border-base-300 px-4 py-4 sm:px-5" aria-labelledby="usage-chart-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="usage-chart-title" className="text-base font-semibold">
          Spend per month
        </h2>
        <span className="flex gap-4 text-[13px] text-base-content/60" aria-hidden="true">
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-primary" />
            Transcription
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: LLM_SERIES }} />
            LLM
          </span>
        </span>
      </div>
      <div role="img" aria-label={summary} className={`grid h-48 items-end border-b border-divider px-1 sm:px-2 ${dense ? "gap-1 sm:gap-3" : "gap-3 sm:gap-6"}`} style={cols}>
        {rows.map((r) => {
          const dim = highlighted.size > 0 && !highlighted.has(r.month);
          const txH = max > 0 ? (r.tx / max) * 150 : 0;
          const llmH = max > 0 ? (r.llm / max) * 150 : 0;
          return (
            <div
              key={r.month}
              className={`flex h-full flex-col items-center justify-end gap-1.5 transition-opacity ${dim ? "opacity-45" : ""}`}
              title={`${monthName(r.month, "long", true)}: ${formatUsageUsd(r.total)} (transcription ${formatUsageUsd(r.tx)}, LLM ${formatUsageUsd(r.llm)})`}
            >
              <span className={`text-xs tabular-nums text-base-content/60 ${dense ? "hidden sm:block" : ""}`}>
                {r.loaded ? (r.total > 0 ? formatUsageUsd(r.total) : "$0") : ""}
              </span>
              <span className="flex w-full max-w-12 flex-col gap-0.5">
                {llmH > 0 && <span className="block rounded-t-[3px]" style={{ height: `${Math.max(llmH, 2)}px`, background: LLM_SERIES }} />}
                {txH > 0 && <span className={`block bg-primary ${llmH > 0 ? "" : "rounded-t-[3px]"}`} style={{ height: `${Math.max(txH, 2)}px` }} />}
                {!r.loaded && <span className="block h-6 animate-pulse rounded-t-[3px] bg-active" />}
              </span>
            </div>
          );
        })}
      </div>
      <div className={`-mt-2 grid px-1 sm:px-2 ${dense ? "gap-1 sm:gap-3" : "gap-3 sm:gap-6"}`} style={cols} aria-hidden="true">
        {rows.map((r) => (
          <span key={r.month} className={`truncate text-center text-xs ${highlighted.has(r.month) ? "font-medium text-base-content" : "text-base-content/60"}`}>
            {monthName(r.month)}
          </span>
        ))}
      </div>
      <table className="sr-only">
        <caption>Spend per month</caption>
        <thead>
          <tr>
            <th scope="col">Month</th>
            <th scope="col">Transcription</th>
            <th scope="col">LLM</th>
            <th scope="col">Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.month}>
              <th scope="row">{monthName(r.month, "long", true)}</th>
              <td>{formatUsageUsd(r.tx)}</td>
              <td>{formatUsageUsd(r.llm)}</td>
              <td>{formatUsageUsd(r.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function providerAmount(p: UsageProviderBreakdown): string {
  const parts: string[] = [];
  if ((p.audioSeconds ?? 0) > 0) parts.push(`${formatUsageHours(p.audioSeconds)} audio`);
  if ((p.totalTokens ?? 0) > 0) parts.push(`${formatUsageTokens(p.totalTokens)} tokens`);
  return parts.join(" · ") || "—";
}

function shortDate(ts: number): string {
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: sameYear ? undefined : "numeric" }).format(d);
}

const MEETINGS_PREVIEW = 8;

export function UsageView({ onSelectMeeting }: { onSelectMeeting: (id: string) => void }): ReactElement {
  const currentMonth = new Date().toISOString().slice(0, 7);
  const [period, setPeriod] = useState<UsagePeriod>("this");
  const [customMonth, setCustomMonth] = useState(currentMonth);
  const [monthData, setMonthData] = useState<Record<string, UsageSummary | undefined>>({});
  const [allTime, setAllTime] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAllMeetings, setShowAllMeetings] = useState(false);

  const chartEnd = period === "custom" ? customMonth : currentMonth;
  const chartLen = period === "all" ? 12 : 6;
  const chartMonths = useMemo(
    () => Array.from({ length: chartLen }, (_, i) => shiftMonth(chartEnd, i - chartLen + 1)),
    [chartEnd, chartLen],
  );
  const chartKey = chartMonths.join(",");

  // One request per visible month (cached across period switches).
  useEffect(() => {
    let cancelled = false;
    const missing = chartMonths.filter((m) => !(m in monthData));
    if (missing.length === 0) return;
    setError(null);
    void Promise.all(missing.map(async (m) => [m, await fetchUsage(`month=${encodeURIComponent(m)}`)] as const))
      .then((entries) => {
        if (!cancelled) setMonthData((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
      })
      .catch((exc: unknown) => {
        if (!cancelled) setError(exc instanceof Error ? exc.message : "Failed to load usage");
      });
    return () => {
      cancelled = true;
    };
  }, [chartKey]);

  useEffect(() => {
    if (period !== "all" || allTime) return;
    let cancelled = false;
    setError(null);
    fetchUsage("period=all")
      .then((data) => {
        if (!cancelled) setAllTime(data);
      })
      .catch((exc: unknown) => {
        if (!cancelled) setError(exc instanceof Error ? exc.message : "Failed to load usage");
      });
    return () => {
      cancelled = true;
    };
  }, [period, allTime]);

  const lastMonth = shiftMonth(currentMonth, -1);
  const selectedMonths =
    period === "this" ? [currentMonth] : period === "last" ? [lastMonth] : period === "custom" ? [customMonth] : period === "6m" ? chartMonths : [];
  const summary: UsageSummary | null = useMemo(() => {
    if (period === "all") return allTime;
    const parts = selectedMonths.map((m) => monthData[m]);
    if (parts.some((p) => !p)) return null;
    return parts.length === 1 ? parts[0]! : combineSummaries(parts as UsageSummary[]);
  }, [period, allTime, monthData, selectedMonths.join(",")]);

  const singleMonth = selectedMonths.length === 1 ? selectedMonths[0] : null;
  const previous = singleMonth ? monthData[shiftMonth(singleMonth, -1)] : undefined;
  const delta = summary && previous ? percentChange(summary.totalCostUsd, previous.totalCostUsd) : null;

  const rates = (summary ?? Object.values(monthData).find(Boolean) ?? allTime)?.rates?.transcriptionUsdPerHour;
  const byProvider = summary?.byProvider ?? [];
  const byMeeting = summary?.byMeeting ?? [];
  const meetingsShown = showAllMeetings ? byMeeting : byMeeting.slice(0, MEETINGS_PREVIEW);
  const rateNote = rates
    ? Object.entries(rates)
        .filter(([, v]) => (v ?? 0) > 0)
        .map(([k, v]) => `${k} $${Number(v).toFixed(2)}/h`)
        .join(", ")
    : null;
  const periodPhrase =
    period === "all" ? "yet" : period === "6m" ? "in the last 6 months" : singleMonth ? `in ${monthName(singleMonth, "long", true)}` : "";

  return (
    <div className="flex flex-col gap-6">
      <div className="-mt-3 flex flex-wrap items-end justify-between gap-4">
        <p className="text-base-content/60">
          Estimated cloud spend: transcription per hour of audio, LLM per token. Local transcription is free.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <div role="radiogroup" aria-label="Period" className="flex rounded-lg bg-hover p-[3px]">
            {PERIODS.map((p) => {
              const on = period === p.key;
              return (
                <button
                  key={p.key}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => {
                    setPeriod(p.key);
                    setShowAllMeetings(false);
                  }}
                  className={`min-h-10 rounded-md px-2.5 text-[13px] sm:min-h-[30px] sm:px-3 ${
                    on ? "bg-base-100 font-semibold shadow-sm" : "text-base-content/70 hover:text-base-content"
                  }`}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
          <input
            type="month"
            value={customMonth}
            max={currentMonth}
            onChange={(e) => {
              if (e.target.value) {
                setCustomMonth(e.target.value);
                setPeriod("custom");
                setShowAllMeetings(false);
              }
            }}
            aria-label="Pick a month"
            title="Pick a month"
            className={`input input-sm min-h-11 w-40 sm:min-h-9 ${period === "custom" ? "border-primary" : ""}`}
          />
        </div>
      </div>

      {error && <p className="text-sm text-error">{error}</p>}

      {summary ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <StatCard
            label="Total"
            value={formatUsageUsd(summary.totalCostUsd)}
            sub={[delta && singleMonth ? `${delta} vs ${monthName(shiftMonth(singleMonth, -1), "long")}` : null, `${summary.eventCount} billed events`]
              .filter(Boolean)
              .join(" · ")}
          />
          <StatCard label="Transcription" value={formatUsageUsd(summary.transcriptionCostUsd)} sub={`${formatUsageHours(summary.audioSeconds)} of audio`} />
          <StatCard
            label="LLM"
            value={formatUsageUsd(summary.llmCostUsd)}
            sub={`${formatUsageTokens(summary.totalTokens)} tokens · ${formatUsageTokens(summary.inputTokens)} in / ${formatUsageTokens(summary.outputTokens)} out`}
          />
        </div>
      ) : !error ? (
        <p className="text-sm text-base-content/60">Loading usage…</p>
      ) : null}

      <SpendChart months={chartMonths} data={monthData} highlighted={new Set(selectedMonths)} />

      {summary && (
        <div className="flex flex-wrap gap-x-6 gap-y-6">
          <section className="flex min-w-0 flex-[1_1_380px] flex-col gap-2" aria-labelledby="usage-providers">
            <h2 id="usage-providers" className="text-base font-semibold">
              By provider
            </h2>
            {byProvider.length === 0 ? (
              <p className="text-sm text-base-content/60">No cloud usage {periodPhrase}. Local transcription is free.</p>
            ) : (
              <ul className="border-t border-divider">
                {byProvider.map((p) => (
                  <li key={p.provider} className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto_4.5rem] items-center gap-3 border-b border-divider py-1.5">
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-medium">{p.provider}</span>
                      {(p.kinds ?? []).length > 0 && <span className="truncate text-xs text-base-content/50">{(p.kinds ?? []).join(", ")}</span>}
                    </span>
                    <span className="text-right text-[13px] text-base-content/60">{providerAmount(p)}</span>
                    <span className="text-right font-medium tabular-nums">{formatUsageUsd(p.costUsd)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="flex min-w-0 flex-[1_1_380px] flex-col gap-2" aria-labelledby="usage-meetings">
            <h2 id="usage-meetings" className="text-base font-semibold">
              Most expensive meetings
            </h2>
            {byMeeting.length === 0 ? (
              <p className="text-sm text-base-content/60">No per-meeting usage {periodPhrase}.</p>
            ) : (
              <>
                <ul className="border-t border-divider">
                  {meetingsShown.map((m) => (
                    <li key={m.meetingId} className="border-b border-divider">
                      <button
                        type="button"
                        onClick={() => onSelectMeeting(m.meetingId)}
                        className="grid min-h-11 w-full grid-cols-[minmax(0,1fr)_auto_4.5rem] items-center gap-3 rounded px-1 py-1.5 text-left hover:bg-hover"
                      >
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate font-medium">{m.meetingTitle || "Untitled meeting"}</span>
                          <span className="truncate text-xs text-base-content/50">
                            {[
                              (m.audioSeconds ?? 0) > 0 ? `${formatUsageHours(m.audioSeconds)} audio` : null,
                              `transcription ${formatUsageUsd(m.transcriptionCostUsd)}`,
                              `LLM ${formatUsageUsd(m.llmCostUsd)} (${formatUsageTokens(m.totalTokens)})`,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        </span>
                        <span className="text-right text-[13px] text-base-content/60">{m.meetingStartTime ? shortDate(m.meetingStartTime) : ""}</span>
                        <span className="text-right font-medium tabular-nums">{formatUsageUsd(m.totalCostUsd)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                {byMeeting.length > MEETINGS_PREVIEW && (
                  <button
                    type="button"
                    onClick={() => setShowAllMeetings((v) => !v)}
                    className="inline-flex min-h-11 items-center self-start rounded-md px-2 text-sm text-base-content/70 hover:bg-hover hover:text-base-content sm:min-h-8"
                  >
                    {showAllMeetings ? "Show fewer" : `Show all ${byMeeting.length} meetings`}
                  </button>
                )}
              </>
            )}
          </section>
        </div>
      )}

      <p className="text-xs text-base-content/60">
        Estimates, not invoices.{rateNote ? ` Transcription rates: ${rateNote}.` : ""} LLM per-token rates vary by model (see the AI
        model picker for per-model pricing). Summary LLM usage is tracked from the usage-tracking update onward; older summaries
        predate it, while transcription and chat history were backfilled.
      </p>
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
