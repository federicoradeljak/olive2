import { useCallback, useEffect, useState } from "react";
import { Pause } from "lucide-react";
import type { TranscriptionProgressUpdate } from "../api/types.ts";

export interface DebugQueueJob {
  workflowId: string;
  name: string;
  rawName: string;
  status: string;
  queueName: string | null;
  parentWorkflowId: string | null;
  meetingId: string | null;
  meetingTitle: string | null;
  createdAt: number | null;
  dequeuedAt: number | null;
  completedAt: number | null;
  elapsedMs: number | null;
  waitingMs: number | null;
  queuePosition: number | null;
  deduplicationId: string | null;
  priority: number | null;
  recoveryAttempts: number | null;
  error: string | null;
}

export interface DebugStageQueue {
  name: string;
  workerConcurrency: number;
  activeCount: number;
  waitingCount: number;
  activeJobs: DebugQueueJob[];
  waitingJobs: DebugQueueJob[];
  recentJobs: DebugQueueJob[];
}

export interface DebugQueuesSnapshot {
  timestamp: number;
  dbosDatabaseUrl: string;
  summary: {
    totalQueues: number;
    totalActiveJobs: number;
    totalWaitingJobs: number;
    activeParentWorkflows: number;
  };
  queues: DebugStageQueue[];
  activeWorkflows: DebugQueueJob[];
  activeTranscriptions: Record<string, TranscriptionProgressUpdate>;
  runningStageRuns: Array<{
    id: string;
    meetingId: string;
    meetingTitle: string | null;
    stage: string;
    status: string;
    jobId: string | null;
    attempts: number;
    startedAt: number | null;
    elapsedMs: number | null;
  }>;
}

export function formatDurationCompact(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const mins = Math.floor(sec / 60);
  const remSec = Math.round(sec % 60);
  return `${mins}m ${remSec}s`;
}

export function DebugQueuesPage() {
  const [snapshot, setSnapshot] = useState<DebugQueuesSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(true);

  const fetchSnapshot = useCallback(async () => {
    try {
      const res = await fetch("/api/debug/queues");
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as DebugQueuesSnapshot;
      setSnapshot(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchSnapshot();
    if (paused) return;
    const timer = setInterval(() => {
      void fetchSnapshot();
    }, 1500);
    return () => clearInterval(timer);
  }, [fetchSnapshot, paused]);

  const allTranscriptionEntries = Object.entries(snapshot?.activeTranscriptions || {});
  const activeTranscriptionEntries = allTranscriptionEntries.filter(
    ([, prog]) => prog.stage !== "queued"
  );
  const queuedTranscriptionCount = allTranscriptionEntries.length - activeTranscriptionEntries.length;

  return (
    <div className="min-h-screen bg-base-100 text-base-content p-6 font-sans">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-base-300 pb-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-bold tracking-tight font-mono">
                /debug · DBOS Stage Queues
              </h1>
              <span
                className={`badge badge-sm gap-1.5 font-medium ${paused ? "badge-neutral" : "badge-success badge-soft"}}`}
              >
                <span
                  className={`status status-xs ${paused ? "status-neutral" : "status-success animate-pulse"}}`}
                />
                {paused ? "Paused" : "Live (1.5s)"}
              </span>
            </div>
            {snapshot && (
              <p className="text-xs text-base-content/50 font-mono mt-1">
                DB: {snapshot.dbosDatabaseUrl} · Updated{" "}
                {new Date(snapshot.timestamp).toLocaleTimeString()}
              </p>
            )}
          </div>

          <div className="flex items-center gap-2">
            <a
              href="/"
              className="btn btn-sm min-h-11"
            >
              ← Back to Olive
            </a>
            <button
              type="button"
              onClick={() => setPaused((p) => !p)}
              className="btn btn-sm min-h-11"
            >
              {paused ? "Resume Polling" : "Pause Polling"}
            </button>
            <button
              type="button"
              onClick={() => void fetchSnapshot()}
              className="btn btn-warning btn-sm min-h-11"
            >
              Refresh Now
            </button>
          </div>
        </div>

        {error && (
          <div className="alert alert-soft alert-error p-4 text-xs font-mono">
            Error loading queue state: {error}
          </div>
        )}

        {loading && !snapshot ? (
          <div className="text-sm text-base-content/50 font-mono">Loading DBOS queue state…</div>
        ) : null}

        {snapshot && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="stat rounded-box border border-base-300 bg-base-200 p-4">
                <div className="stat-title">Stage Queues</div>
                <div className="stat-value font-mono mt-1">
                  {snapshot.summary.totalQueues}
                </div>
              </div>
              <div className="stat rounded-box border border-base-300 bg-base-200 p-4">
                <div className="stat-title">Active Stage Jobs</div>
                <div
                  className={`stat-value font-mono mt-1 ${snapshot.summary.totalActiveJobs > 0 ? "text-warning" : ""}`}
                >
                  {snapshot.summary.totalActiveJobs}
                </div>
              </div>
              <div className="stat rounded-box border border-base-300 bg-base-200 p-4">
                <div className="stat-title">Waiting in Queues</div>
                <div
                  className={`stat-value font-mono mt-1 ${snapshot.summary.totalWaitingJobs > 0 ? "text-info" : ""}`}
                >
                  {snapshot.summary.totalWaitingJobs}
                </div>
              </div>
              <div className="stat rounded-box border border-base-300 bg-base-200 p-4">
                <div className="stat-title">Active Parent Workflows</div>
                <div className="stat-value font-mono mt-1">
                  {snapshot.summary.activeParentWorkflows}
                </div>
              </div>
            </div>

            {(activeTranscriptionEntries.length > 0 ||
              queuedTranscriptionCount > 0 ||
              snapshot.runningStageRuns.length > 0) && (
              <div className="rounded-box border border-warning/30 bg-warning/5 p-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-xs font-semibold uppercase tracking-wider text-warning">
                    Live Pipeline Activity
                  </h2>
                  {queuedTranscriptionCount > 0 && (
                    <span className="badge badge-sm badge-info badge-soft font-mono">
                      +{queuedTranscriptionCount} queued in pipeline
                    </span>
                  )}
                </div>
                {activeTranscriptionEntries.map(([mid, prog]) => (
                  <div
                    key={mid}
                    className="rounded-lg border border-base-300 bg-base-200/90 p-3 flex flex-wrap items-center justify-between gap-3 text-xs"
                  >
                    <div className="space-y-0.5">
                      <div className="font-mono text-base-content">
                        Meeting <span className="text-warning">{mid}</span> · Stage{" "}
                        <span className="font-semibold text-base-content">{prog.stage}</span>
                      </div>
                      <div className="text-base-content/70">{prog.message}</div>
                    </div>
                    <div className="font-mono text-sm font-bold text-warning">
                      {Math.round(prog.percent ?? 0)}%
                    </div>
                  </div>
                ))}
                {snapshot.runningStageRuns.length > 0 && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {snapshot.runningStageRuns.map((sr) => (
                      <div
                        key={sr.id}
                        className="rounded-lg border border-base-300 bg-base-200/70 px-3 py-2 flex items-center justify-between text-xs font-mono"
                      >
                        <div className="truncate">
                          <span className="text-warning">{sr.stage}</span> ·{" "}
                          <span className="text-base-content">
                            {sr.meetingTitle || sr.meetingId}
                          </span>{" "}
                          <span className="text-base-content/50">({sr.jobId || sr.id.slice(0, 8)})</span>
                        </div>
                        <span className="text-base-content/70 ml-2 shrink-0">
                          {formatDurationCompact(sr.elapsedMs)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {snapshot.queues.map((q) => {
                const isBusy = q.activeCount > 0;
                const hasWaiting = q.waitingCount > 0;
                return (
                  <div
                    key={q.name}
                    className={`card card-border bg-base-200 p-4 space-y-3 ${
                      isBusy
                        ? "border-warning/50"
                        : hasWaiting
                        ? "border-info/40"
                        : "border-base-300"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2.5">
                        <span className="font-mono text-sm font-bold text-base-content">
                          {q.name}
                        </span>
                        <span
                          className={`badge badge-sm font-mono font-semibold ${
                            isBusy
                              ? "badge-warning"
                              : hasWaiting
                              ? "badge-info badge-soft"
                              : "badge-neutral"
                          }`}
                        >
                          {isBusy ? "ACTIVE" : hasWaiting ? "QUEUED" : "IDLE"}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 text-xs font-mono text-base-content/70">
                        <span>
                          Workers: <strong className="text-base-content">{q.activeCount}</strong>/
                          {q.workerConcurrency}
                        </span>
                        <span>
                          Depth: <strong className="text-base-content">{q.waitingCount}</strong>
                        </span>
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <div className="text-[11px] font-semibold uppercase tracking-wider text-base-content/70">
                        Currently Active ({q.activeJobs.length})
                      </div>
                      {q.activeJobs.length === 0 ? (
                        <div className="rounded-lg border border-base-300/70 bg-base-100/50 px-3 py-2 text-xs text-base-content/50 font-mono">
                          No active job
                        </div>
                      ) : (
                        q.activeJobs.map((job) => (
                          <div
                            key={job.workflowId}
                            className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs font-mono space-y-1"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-semibold text-warning">{job.name}</span>
                              <span className="text-warning">
                                {formatDurationCompact(job.elapsedMs)}
                              </span>
                            </div>
                            <div className="text-base-content truncate">
                              ID: <span className="text-base-content/70">{job.workflowId}</span>
                            </div>
                            {(job.meetingTitle || job.meetingId) && (
                              <div className="text-base-content truncate">
                                Meeting:{" "}
                                <span className="text-base-content">
                                  {job.meetingTitle || job.meetingId}
                                </span>
                                {job.meetingTitle && job.meetingId ? (
                                  <span className="text-base-content/50"> ({job.meetingId})</span>
                                ) : null}
                              </div>
                            )}
                            {(() => {
                              const prog = job.meetingId
                                ? snapshot.activeTranscriptions[job.meetingId]
                                : undefined;
                              if (!prog) return null;
                              return (
                                <div className="space-y-0.5 pt-0.5">
                                  <div className="text-warning">
                                    Stage: <span className="text-base-content">{prog.stage}</span> · {Math.round(prog.percent ?? 0)}%
                                    {prog.current != null && prog.total != null
                                      ? ` · batch ${prog.current}/${prog.total}`
                                      : ""}
                                  </div>
                                  {prog.message && (
                                    <div className="text-base-content/70">{prog.message}</div>
                                  )}
                                </div>
                              );
                            })()}
                          </div>
                        ))
                      )}
                    </div>

                    <div className="space-y-1.5">
                      <div className="text-[11px] font-semibold uppercase tracking-wider text-base-content/70">
                        Waiting Queue ({q.waitingJobs.length})
                      </div>
                      {q.waitingJobs.length === 0 ? (
                        <div className="rounded-lg border border-base-300/70 bg-base-100/50 px-3 py-2 text-xs text-base-content/50 font-mono">
                          Queue empty
                        </div>
                      ) : (
                        <div className="space-y-1.5 max-h-48 overflow-y-auto">
                          {q.waitingJobs.map((job) => (
                            <div
                              key={job.workflowId}
                              className="rounded-lg border border-info/30 bg-info/20 px-3 py-2 text-xs font-mono space-y-1"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span>
                                  <span className="text-info font-bold">
                                    #{job.queuePosition}
                                  </span>{" "}
                                  <span className="text-base-content font-semibold">{job.name}</span>
                                </span>
                                <span className="text-base-content/70">
                                  wait {formatDurationCompact(job.waitingMs)}
                                </span>
                              </div>
                              <div className="text-base-content/70 truncate">ID: {job.workflowId}</div>
                              {(job.meetingTitle || job.meetingId) && (
                                <div className="text-base-content truncate">
                                  Meeting: {job.meetingTitle || job.meetingId}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {q.recentJobs.length > 0 && (
                      <details className="group pt-1">
                        <summary className="cursor-pointer text-[11px] font-mono text-base-content/70 hover:text-base-content select-none">
                          Recent jobs ({q.recentJobs.length})
                        </summary>
                        <div className="mt-2 space-y-1 max-h-40 overflow-y-auto">
                          {q.recentJobs.map((job) => (
                            <div
                              key={job.workflowId}
                              className="rounded border border-base-300 bg-base-100/80 px-2.5 py-1.5 text-[11px] font-mono flex items-center justify-between gap-2"
                            >
                              <div className="truncate">
                                <span
                                  className={`mr-2 ${
                                    job.status === "SUCCESS"
                                      ? "text-success"
                                      : job.status === "CANCELLED"
                                      ? "text-base-content/70"
                                      : "text-error"
                                  }`}
                                >
                                  {job.status}
                                </span>
                                <span className="text-base-content">{job.name}</span>
                                {job.meetingTitle || job.meetingId ? (
                                  <span className="text-base-content/70">
                                    {" "}
                                    · {job.meetingTitle || job.meetingId}
                                  </span>
                                ) : null}
                                <span className="text-base-content/50"> ({job.workflowId})</span>
                              </div>
                              <span className="text-base-content/70 shrink-0">
                                {formatDurationCompact(job.elapsedMs)}
                              </span>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
