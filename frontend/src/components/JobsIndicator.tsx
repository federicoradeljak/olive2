import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { DebugQueueJob, DebugQueuesSnapshot } from "../views/DebugQueues";
import { describeJob } from "../lib/jobs";

const POLL_MS = 5000;

/* Polls the queue snapshot while the tab is visible. Shared by the sidebar
   card and the mobile header pill. */
export function useJobsSnapshot(): DebugQueuesSnapshot | null {
  const [snapshot, setSnapshot] = useState<DebugQueuesSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch("/api/debug/queues");
        if (res.ok && !cancelled) setSnapshot((await res.json()) as DebugQueuesSnapshot);
      } catch {
        // offline: keep the last snapshot
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    document.addEventListener("visibilitychange", load);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, []);

  return snapshot;
}

function runningJobs(snapshot: DebugQueuesSnapshot | null): { active: DebugQueueJob[]; waiting: DebugQueueJob[] } {
  if (!snapshot) return { active: [], waiting: [] };
  return {
    active: snapshot.queues.flatMap((q) => q.activeJobs),
    waiting: snapshot.queues.flatMap((q) => q.waitingJobs),
  };
}

export function JobsIndicator({
  snapshot,
  onOpenActivity,
  onSelectMeeting,
  variant = "card",
}: {
  snapshot: DebugQueuesSnapshot | null;
  onOpenActivity: () => void;
  onSelectMeeting: (id: string) => void;
  variant?: "card" | "pill";
}): ReactElement | null {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const { active, waiting } = runningJobs(snapshot);
  const total = active.length + waiting.length;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (total === 0) return null;

  const label = active.length > 0 ? `${active.length} running` : `${waiting.length} queued`;

  return (
    <div ref={rootRef} className="relative">
      {variant === "card" ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex w-full flex-col gap-1.5 rounded-lg border border-base-300 bg-base-100 px-3 py-2.5 text-left text-sm hover:bg-hover"
        >
          <span className="flex items-center gap-2 font-medium">
            <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-primary" aria-hidden="true" />
            {label}
            {active.length > 0 && waiting.length > 0 && <span className="font-normal text-base-content/55">· {waiting.length} queued</span>}
          </span>
          {active[0] && <span className="truncate text-xs text-base-content/60">{describeJob(active[0])}</span>}
        </button>
      ) : (
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${total} background jobs`}
          onClick={() => setOpen((v) => !v)}
          className="flex h-8 items-center gap-1.5 rounded-full border border-base-300 px-2.5 text-xs font-medium"
        >
          <span className="h-2 w-2 animate-pulse rounded-full bg-primary" aria-hidden="true" />
          {label}
        </button>
      )}
      {open && (
        <div
          className={`absolute z-50 w-[22rem] max-w-[calc(100vw-2rem)] rounded-xl bg-base-100 p-1.5 shadow-pop ${
            variant === "card" ? "bottom-full left-0 mb-2" : "right-0 top-full mt-2"
          }`}
        >
          <div className="flex items-center justify-between px-2.5 py-2">
            <span className="font-semibold">Running now</span>
            <button
              type="button"
              className="text-sm text-primary hover:underline"
              onClick={() => {
                setOpen(false);
                onOpenActivity();
              }}
            >
              Open Activity
            </button>
          </div>
          <ul className="max-h-80 overflow-y-auto">
            {[...active, ...waiting].slice(0, 8).map((job) => {
              const isActive = active.includes(job);
              return (
                <li key={job.workflowId}>
                  <button
                    type="button"
                    disabled={!job.meetingId}
                    onClick={() => {
                      if (!job.meetingId) return;
                      setOpen(false);
                      onSelectMeeting(job.meetingId);
                    }}
                    className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-hover disabled:cursor-default disabled:hover:bg-transparent"
                  >
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${isActive ? "bg-primary" : "bg-warning"}`} aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{describeJob(job)}</span>
                      <span className="block truncate text-xs text-base-content/60">
                        {isActive ? "Running" : job.queuePosition != null ? `Queued · #${job.queuePosition + 1} in line` : "Queued"}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
