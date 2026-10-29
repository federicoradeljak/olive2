import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { X } from "lucide-react";
import type { DebugQueuesSnapshot } from "../views/DebugQueues";
import { KIND_COLOR, activityFraction, activityMeta, activityTitle, buildActivity } from "../lib/jobs";
import type { ActivityItem } from "../lib/jobs";
import { confirmAction } from "./ui";

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

function Dot({ item }: { item: ActivityItem }): ReactElement {
  const color = item.state === "queued" ? "yellow" : KIND_COLOR[item.kind];
  return <span className="mt-[7px] h-2 w-2 shrink-0 rounded-full" style={{ background: `var(--tag-${color})` }} aria-hidden="true" />;
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
  const [cancelled, setCancelled] = useState<Set<string>>(new Set());
  const rootRef = useRef<HTMLDivElement | null>(null);
  const { running, queued } = buildActivity(snapshot);
  const total = running.length + queued.length;

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

  const label =
    running.length > 0
      ? variant === "card"
        ? `${running.length} ${running.length === 1 ? "job" : "jobs"} running`
        : `${running.length} running`
      : `${queued.length} queued`;

  const cancel = async (item: ActivityItem) => {
    if (!item.meetingId) return;
    const ok = await confirmAction({
      title: "Cancel transcription",
      message: `Stop transcribing "${item.meetingTitle || "this meeting"}"?`,
      confirmLabel: "Cancel transcription",
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/meetings/${item.meetingId}/transcribe/cancel`, { method: "POST" });
      if (res.ok) setCancelled((s) => new Set(s).add(item.key));
    } catch {
      // the next poll shows the real state
    }
  };

  const items = [...running, ...queued].slice(0, 8);

  return (
    <div ref={rootRef} className="relative">
      {variant === "card" ? (
        <button
          type="button"
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full flex-col gap-1 rounded-lg border border-base-300 bg-base-100 px-3 py-2.5 text-left text-sm hover:bg-hover"
        >
          <span className="flex items-center gap-2 font-medium">
            <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-primary" aria-hidden="true" />
            {label}
            {running.length > 0 && queued.length > 0 && <span className="font-normal text-base-content/55">· {queued.length} queued</span>}
          </span>
          {(running[0] ?? queued[0]) && <span className="truncate text-xs text-base-content/60">{activityTitle(running[0] ?? queued[0])}</span>}
        </button>
      ) : (
        <button
          type="button"
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={`${total} background ${total === 1 ? "job" : "jobs"}`}
          onClick={() => setOpen((v) => !v)}
          className="flex min-h-11 items-center gap-1.5 rounded-full px-1 text-xs font-medium"
        >
          <span className="flex h-8 items-center gap-1.5 rounded-full border border-base-300 px-2.5">
            <span className="h-2 w-2 animate-pulse rounded-full bg-primary" aria-hidden="true" />
            {label}
          </span>
        </button>
      )}
      {open && (
        <section
          role="dialog"
          aria-label="Background jobs"
          className={`absolute z-50 w-[22.5rem] max-w-[calc(100vw-2rem)] rounded-xl bg-base-100 p-1.5 shadow-pop ${
            variant === "card" ? "bottom-full left-0 mb-2" : "right-0 top-full mt-1"
          }`}
        >
          <div className="flex items-center justify-between px-2.5 py-2">
            <span className="font-semibold">Running now</span>
            <button
              type="button"
              className="min-h-11 text-[13px] text-primary hover:underline sm:min-h-0"
              onClick={() => {
                setOpen(false);
                onOpenActivity();
              }}
            >
              Open Activity
            </button>
          </div>
          <ul className="max-h-80 overflow-y-auto">
            {items.map((item) => {
              const fraction = item.state === "running" ? activityFraction(item) : null;
              const canCancel = item.kind === "transcription" && !!item.meetingId && !cancelled.has(item.key);
              const meetingId = item.meetingId;
              return (
                <li key={item.key} className="flex items-start gap-1 rounded-lg hover:bg-hover">
                  <button
                    type="button"
                    disabled={!meetingId}
                    onClick={() => {
                      if (!meetingId) return;
                      setOpen(false);
                      onSelectMeeting(meetingId);
                    }}
                    className="flex min-w-0 flex-1 items-start gap-2 px-2.5 py-2 text-left text-sm disabled:cursor-default"
                  >
                    <Dot item={item} />
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="truncate font-medium">{activityTitle(item)}</span>
                      <span className="truncate text-xs text-base-content/60">
                        {cancelled.has(item.key) ? "Cancelling…" : activityMeta(item)}
                      </span>
                      {fraction != null && (
                        <span className="block h-1 overflow-hidden rounded-full bg-active">
                          <span className="block h-full rounded-full bg-primary" style={{ width: `${Math.round(fraction * 100)}%` }} />
                        </span>
                      )}
                    </span>
                  </button>
                  {canCancel && (
                    <button
                      type="button"
                      onClick={() => void cancel(item)}
                      aria-label={`Cancel: ${activityTitle(item)}`}
                      className="mr-1 mt-1 inline-flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-md px-2 text-xs text-base-content/60 hover:bg-active hover:text-base-content sm:min-h-[26px] sm:min-w-0"
                    >
                      <X className="h-3.5 w-3.5 sm:hidden" aria-hidden="true" />
                      <span className="hidden sm:inline">Cancel</span>
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          {total > items.length && (
            <p className="px-2.5 pb-1.5 pt-1 text-xs text-base-content/50">and {total - items.length} more in Activity</p>
          )}
        </section>
      )}
    </div>
  );
}
