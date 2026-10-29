import { useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { Check, ChevronRight, Pause, Play, RotateCw, X } from "lucide-react";
import { confirmAction } from "../../components/ui";
import type { DebugQueueJob, DebugQueuesSnapshot, DebugStageQueue, DebugStageRun } from "../DebugQueues";
import { formatDurationCompact } from "../DebugQueues";
import {
  KIND_COLOR,
  LOCAL_STEPS,
  activityFraction,
  activityMeta,
  activityTitle,
  buildActivity,
  describeJob,
  jobKind,
  queueEngine,
  queueTitle,
} from "../../lib/jobs";
import type { ActivityItem } from "../../lib/jobs";

const btnGhost =
  "inline-flex min-h-11 items-center gap-1.5 rounded-md px-2.5 text-sm text-base-content/70 hover:bg-hover hover:text-base-content sm:min-h-8";
const btnOutline =
  "inline-flex min-h-11 items-center gap-1.5 rounded-md border border-base-300 px-2.5 text-sm hover:bg-hover disabled:opacity-50 sm:min-h-8";

function formatClock(ts: number | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(undefined, sameDay ? { timeStyle: "short" } : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(d);
}

function formatStamp(ts: number | null | undefined): string {
  return ts ? new Date(ts).toLocaleString() : "—";
}

/* ---------- Technical details (everything the old /debug page showed) ---------- */

function Disclosure({ label = "Details", children }: { label?: string; children: ReactNode }): ReactElement {
  return (
    <details className="group">
      <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1 rounded text-xs text-base-content/55 select-none hover:text-base-content sm:min-h-6 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" aria-hidden="true" />
        {label}
      </summary>
      <div className="mt-1.5 space-y-2">{children}</div>
    </details>
  );
}

function KV({ rows }: { rows: Array<[string, ReactNode]> }): ReactElement {
  return (
    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5 font-mono text-[11px] leading-relaxed">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-base-content/50">{k}</dt>
          <dd className="break-all text-base-content/80">{v ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

function JobTech({ job }: { job: DebugQueueJob }): ReactElement {
  return (
    <div className="rounded-md bg-base-200 px-3 py-2">
      <KV
        rows={[
          ["step", job.name],
          ["workflow", job.rawName || "—"],
          ["workflow id", job.workflowId],
          ["status", job.status],
          ["queue", job.queueName ?? "—"],
          ["meeting id", job.meetingId ?? "—"],
          ["dedup id", job.deduplicationId ?? "—"],
          ["parent", job.parentWorkflowId ?? "—"],
          ["position", job.queuePosition != null ? `#${job.queuePosition}` : "—"],
          ["priority", job.priority ?? "—"],
          ["recoveries", job.recoveryAttempts ?? "—"],
          ["created", formatStamp(job.createdAt)],
          ["dequeued", formatStamp(job.dequeuedAt)],
          ["completed", formatStamp(job.completedAt)],
          ["elapsed", formatDurationCompact(job.elapsedMs)],
          ["waited", formatDurationCompact(job.waitingMs)],
        ]}
      />
      {job.error && <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] text-error">{job.error}</pre>}
    </div>
  );
}

function StageRunTech({ run }: { run: DebugStageRun }): ReactElement {
  return (
    <div className="rounded-md bg-base-200 px-3 py-2">
      <KV
        rows={[
          ["stage run", run.stage],
          ["status", run.status],
          ["id", run.id],
          ["job id", run.jobId ?? "—"],
          ["attempts", run.attempts],
          ["started", formatStamp(run.startedAt)],
          ["elapsed", formatDurationCompact(run.elapsedMs)],
        ]}
      />
    </div>
  );
}

function ItemTech({ item }: { item: ActivityItem }): ReactElement {
  const p = item.progress;
  return (
    <Disclosure>
      {p && (
        <div className="rounded-md bg-base-200 px-3 py-2">
          <KV
            rows={[
              ["progress", `${p.stage} · ${Math.round(p.percent ?? 0)}%`],
              ["batch", p.current != null && p.total != null ? `${p.current}/${p.total}` : "—"],
              ["message", p.message || "—"],
              ...(p.stageRunId ? ([["stage run id", p.stageRunId]] as Array<[string, ReactNode]>) : []),
              ...(p.error ? ([["error", p.error]] as Array<[string, ReactNode]>) : []),
            ]}
          />
        </div>
      )}
      {item.stageRuns.map((r) => (
        <StageRunTech key={r.id} run={r} />
      ))}
      {item.jobs.map((j) => (
        <JobTech key={j.workflowId} job={j} />
      ))}
    </Disclosure>
  );
}

/* ---------- Pieces ---------- */

function MeetingLink({
  item,
  onSelectMeeting,
  children,
}: {
  item: { meetingId: string | null };
  onSelectMeeting: (id: string) => void;
  children: ReactNode;
}): ReactElement {
  if (!item.meetingId) return <span className="min-w-0 truncate font-semibold">{children}</span>;
  const id = item.meetingId;
  return (
    <button type="button" onClick={() => onSelectMeeting(id)} className="min-w-0 truncate text-left font-semibold hover:underline">
      {children}
    </button>
  );
}

function ProgressBar({ fraction, active }: { fraction: number | null; active?: boolean }): ReactElement {
  const width = fraction == null ? (active ? 35 : 0) : Math.round(fraction * 100);
  return (
    <span className="block h-1 overflow-hidden rounded-full bg-active">
      <span
        className={`block h-full rounded-full bg-primary transition-[width] ${active && fraction == null ? "animate-pulse" : ""}`}
        style={{ width: `${width}%` }}
      />
    </span>
  );
}

function LocalStepper({ item }: { item: ActivityItem }): ReactElement {
  const fraction = activityFraction(item);
  return (
    <ol className="grid grid-cols-2 gap-x-3 gap-y-3 sm:grid-cols-4" aria-label="Pipeline stages">
      {LOCAL_STEPS.map((step, i) => {
        const state = i < item.stepIndex ? "done" : i === item.stepIndex ? "run" : "todo";
        return (
          <li key={step.key} className="flex flex-col gap-1.5" aria-current={state === "run" ? "step" : undefined}>
            {state === "done" ? <ProgressBar fraction={1} /> : state === "run" ? <ProgressBar fraction={fraction} active /> : <ProgressBar fraction={0} />}
            <span
              className={`flex items-center gap-1 text-xs ${
                state === "todo" ? "text-base-content/50" : state === "run" ? "font-semibold" : "text-base-content/80"
              }`}
            >
              {state === "done" && <Check className="h-3 w-3 shrink-0 text-primary" aria-hidden="true" />}
              {step.label}
              {state === "run" && fraction != null ? ` · ${Math.round(fraction * 100)}%` : ""}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function RunningCard({
  item,
  onSelectMeeting,
  onCancel,
  cancelling,
}: {
  item: ActivityItem;
  onSelectMeeting: (id: string) => void;
  onCancel: (item: ActivityItem) => void;
  cancelling: boolean;
}): ReactElement {
  const fraction = activityFraction(item);
  const canCancel = item.kind === "transcription" && !!item.meetingId;
  return (
    <div className="flex flex-col gap-3 rounded-box border border-base-300 p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className={`tag tag-dot tag-${KIND_COLOR[item.kind]} shrink-0`}>{item.kind === "transcription" ? "Transcription" : item.kind === "summary" ? "Summary" : item.kind === "sync" ? "Sync" : "Job"}</span>
        <MeetingLink item={item} onSelectMeeting={onSelectMeeting}>
          {item.meetingId ? item.meetingTitle || "Untitled meeting" : activityTitle(item)}
        </MeetingLink>
        <span className="flex-1" />
        {canCancel && (
          <button type="button" className={btnOutline} disabled={cancelling} onClick={() => onCancel(item)}>
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            {cancelling ? "Cancelling…" : "Cancel"}
          </button>
        )}
      </div>
      <p className="-mt-1.5 text-sm text-base-content/60">{activityMeta(item)}</p>
      {item.local ? <LocalStepper item={item} /> : fraction != null ? <ProgressBar fraction={fraction} /> : null}
      <ItemTech item={item} />
    </div>
  );
}

function QueueTile({ q }: { q: DebugStageQueue }): ReactElement {
  const busy = q.activeCount > 0;
  const waiting = q.waitingCount > 0;
  const color = busy ? KIND_COLOR[jobKind(q.name)] : waiting ? "yellow" : "gray";
  return (
    <div className="flex flex-col gap-1 rounded-box border border-base-300 p-3" title={q.name}>
      <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: `var(--tag-${color})` }} aria-hidden="true" />
        <span className="truncate">{queueTitle(q.name)}</span>
      </span>
      <span className="text-xl font-semibold tabular-nums">
        {q.activeCount} <span className="text-base-content/40">/</span> {q.workerConcurrency}
      </span>
      <span className="text-xs text-base-content/60">{waiting ? `${q.waitingCount} waiting` : busy ? "Running" : "Idle"}</span>
    </div>
  );
}

const STATUS_PILL: Record<string, { label: string; color: string }> = {
  SUCCESS: { label: "Done", color: "green" },
  ERROR: { label: "Failed", color: "red" },
  MAX_RECOVERY_ATTEMPTS_EXCEEDED: { label: "Gave up", color: "red" },
  CANCELLED: { label: "Cancelled", color: "gray" },
};

function FinishedRow({ job, onSelectMeeting }: { job: DebugQueueJob; onSelectMeeting: (id: string) => void }): ReactElement {
  const pill = STATUS_PILL[job.status] ?? { label: job.status, color: "gray" };
  return (
    <li className="border-b border-divider py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm sm:flex-nowrap">
        <span className={`tag tag-${pill.color} w-[5.5rem] shrink-0 justify-center`}>{pill.label}</span>
        <span className="min-w-0 flex-1 basis-40 truncate">
          {job.meetingId ? (
            <button type="button" onClick={() => onSelectMeeting(job.meetingId!)} className="max-w-full truncate text-left hover:underline">
              {describeJob(job)}
            </button>
          ) : (
            describeJob(job)
          )}
        </span>
        <span className="shrink-0 text-base-content/60 sm:w-32">{queueEngine(job.queueName)}</span>
        <span className="shrink-0 text-right tabular-nums text-base-content/60 sm:w-24" title={formatStamp(job.completedAt)}>
          {formatClock(job.completedAt)}
        </span>
      </div>
      {job.error && <p className="mt-1 truncate pl-0 text-xs text-error sm:pl-[6.25rem]" title={job.error}>{job.error}</p>}
      <div className="sm:pl-[6.25rem]">
        <Disclosure>
          <JobTech job={job} />
        </Disclosure>
      </div>
    </li>
  );
}

/* ---------- Panel ---------- */

export function JobsPanel({
  snapshot,
  error,
  loading,
  paused,
  onTogglePaused,
  onRefresh,
  onSelectMeeting,
}: {
  snapshot: DebugQueuesSnapshot | null;
  error: string | null;
  loading: boolean;
  paused: boolean;
  onTogglePaused: () => void;
  onRefresh: () => Promise<void>;
  onSelectMeeting: (id: string) => void;
}): ReactElement {
  const [cancelling, setCancelling] = useState<Set<string>>(new Set());
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [showAllFinished, setShowAllFinished] = useState(false);
  const { running, queued } = buildActivity(snapshot);

  const queuedInPipeline = Object.values(snapshot?.activeTranscriptions ?? {}).filter((p) => p.stage === "queued").length;

  const finished = (snapshot?.queues ?? [])
    .flatMap((q) => q.recentJobs)
    .sort((a, b) => (b.completedAt ?? b.createdAt ?? 0) - (a.completedAt ?? a.createdAt ?? 0));
  const finishedShown = showAllFinished ? finished : finished.slice(0, 10);

  const cancel = async (item: ActivityItem) => {
    const id = item.meetingId;
    if (!id) return;
    const ok = await confirmAction({
      title: "Cancel transcription",
      message: `Stop transcribing "${item.meetingTitle || "this meeting"}"? Queued stages for this meeting are dropped too.`,
      confirmLabel: "Cancel transcription",
      danger: true,
    });
    if (!ok) return;
    setCancelling((s) => new Set(s).add(item.key));
    setCancelError(null);
    try {
      const res = await fetch(`/api/meetings/${id}/transcribe/cancel`, { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      await onRefresh();
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : String(err));
    } finally {
      setCancelling((s) => {
        const next = new Set(s);
        next.delete(item.key);
        return next;
      });
    }
  };

  return (
    <div className="flex flex-col gap-7">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`inline-flex items-center gap-1.5 text-sm font-medium ${paused ? "text-base-content/60" : "text-primary"}`}>
          <span className={`h-2 w-2 rounded-full ${paused ? "bg-base-content/40" : "animate-pulse bg-primary"}`} aria-hidden="true" />
          {paused ? "Paused" : "Live"}
        </span>
        {snapshot && <span className="text-sm text-base-content/50">· Updated {new Date(snapshot.timestamp).toLocaleTimeString()}</span>}
        <span className="flex-1" />
        <button type="button" className={btnGhost} onClick={onTogglePaused} aria-pressed={paused}>
          {paused ? <Play className="h-4 w-4" aria-hidden="true" /> : <Pause className="h-4 w-4" aria-hidden="true" />}
          {paused ? "Resume" : "Pause"}
        </button>
        <button type="button" className={btnGhost} onClick={() => void onRefresh()}>
          <RotateCw className="h-4 w-4" aria-hidden="true" />
          Refresh
        </button>
      </div>

      {error && <div className="rounded-box border border-error/30 bg-error/5 px-4 py-3 text-sm text-error">Could not load the job queues: {error}</div>}
      {cancelError && <div className="rounded-box border border-error/30 bg-error/5 px-4 py-3 text-sm text-error">Could not cancel: {cancelError}</div>}
      {loading && !snapshot && <p className="text-sm text-base-content/60">Loading background jobs…</p>}

      {snapshot && (
        <>
          <section aria-label="Queue capacity" className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2.5">
            {snapshot.queues.map((q) => (
              <QueueTile key={q.name} q={q} />
            ))}
          </section>

          <section className="flex flex-col gap-2.5" aria-labelledby="jobs-running">
            <h2 id="jobs-running" className="text-base font-semibold">
              Running <span className="font-normal text-base-content/50">{running.length || ""}</span>
            </h2>
            {running.length === 0 ? (
              <p className="text-sm text-base-content/60">Nothing is running right now.</p>
            ) : (
              running.map((item) => (
                <RunningCard key={item.key} item={item} onSelectMeeting={onSelectMeeting} onCancel={(i) => void cancel(i)} cancelling={cancelling.has(item.key)} />
              ))
            )}
          </section>

          {(queued.length > 0 || queuedInPipeline > 0) && (
            <section className="flex flex-col gap-2" aria-labelledby="jobs-queued">
              <h2 id="jobs-queued" className="text-base font-semibold">
                Queued <span className="font-normal text-base-content/50">{queued.length || ""}</span>
              </h2>
              {queuedInPipeline > 0 && (
                <p className="text-sm text-base-content/60">
                  {queuedInPipeline} {queuedInPipeline === 1 ? "transcription is" : "transcriptions are"} waiting to enter the pipeline.
                </p>
              )}
              <ul className="border-t border-divider">
                {queued.map((item) => (
                  <li key={item.key} className="border-b border-divider py-2">
                    <div className="flex items-center gap-3 text-sm">
                      <span className="tag tag-yellow w-12 shrink-0 justify-center tabular-nums">{item.queuePosition != null ? `#${item.queuePosition}` : "—"}</span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <MeetingLink item={item} onSelectMeeting={onSelectMeeting}>
                          <span className="font-medium">{activityTitle(item)}</span>
                        </MeetingLink>
                        <span className="truncate text-xs text-base-content/60">
                          {item.queueName ? `${queueTitle(item.queueName)} · ` : ""}
                          {activityMeta(item)}
                        </span>
                      </span>
                    </div>
                    <div className="pl-[3.75rem]">
                      <ItemTech item={item} />
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="flex flex-col gap-2" aria-labelledby="jobs-finished">
            <h2 id="jobs-finished" className="text-base font-semibold">
              Finished recently
            </h2>
            {finished.length === 0 ? (
              <p className="text-sm text-base-content/60">No finished jobs yet.</p>
            ) : (
              <>
                <ul className="border-t border-divider">
                  {finishedShown.map((job) => (
                    <FinishedRow key={job.workflowId} job={job} onSelectMeeting={onSelectMeeting} />
                  ))}
                </ul>
                {finished.length > finishedShown.length || showAllFinished ? (
                  <button type="button" className={`${btnGhost} self-start`} onClick={() => setShowAllFinished((v) => !v)}>
                    {showAllFinished ? "Show fewer" : `Show all ${finished.length}`}
                  </button>
                ) : null}
              </>
            )}
          </section>

          <section aria-label="Technical details" className="border-t border-divider pt-3">
            <Disclosure label="Technical details">
              <div className="rounded-md bg-base-200 px-3 py-2">
                <KV
                  rows={[
                    ["dbos database", snapshot.dbosDatabaseUrl],
                    ["snapshot", formatStamp(snapshot.timestamp)],
                    ["stage queues", snapshot.summary.totalQueues],
                    ["active stage jobs", snapshot.summary.totalActiveJobs],
                    ["waiting in queues", snapshot.summary.totalWaitingJobs],
                    ["active parent workflows", snapshot.summary.activeParentWorkflows],
                    ["polling", paused ? "paused" : "every 1.5 s"],
                  ]}
                />
              </div>
              {snapshot.activeWorkflows.length > 0 && (
                <>
                  <p className="text-xs font-medium text-base-content/60">Parent workflows</p>
                  {snapshot.activeWorkflows.map((w) => (
                    <JobTech key={w.workflowId} job={w} />
                  ))}
                </>
              )}
            </Disclosure>
          </section>
        </>
      )}
    </div>
  );
}
