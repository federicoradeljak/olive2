import { useState } from "react";
import type { ReactElement } from "react";
import { LogsView } from "./Logs";
import { JobsPanel } from "./activity/JobsPanel";
import { useQueueFeed } from "./activity/useQueueFeed";
import { buildActivity } from "../lib/jobs";

export type ActivityTab = "jobs" | "logs";

const TABS: Array<{ key: ActivityTab; label: string }> = [
  { key: "jobs", label: "Jobs" },
  { key: "logs", label: "Logs" },
];

export function ActivityView({
  tab,
  onNavigateTab,
  onSelectMeeting,
}: {
  tab: ActivityTab;
  onNavigateTab: (tab: ActivityTab) => void;
  onSelectMeeting: (id: string) => void;
}): ReactElement {
  const [paused, setPaused] = useState(false);
  // Fast polling while the Jobs tab is open; slow, count-only polling on Logs.
  const feed = useQueueFeed(tab === "jobs" ? 1500 : 10000, tab === "jobs" && paused);
  const { running, queued } = buildActivity(feed.snapshot);
  const jobCount = running.length + queued.length;

  return (
    <div className="flex flex-col gap-5">
      <p className="-mt-3 text-base-content/60">Everything Olive is doing in the background, and what it did.</p>
      <div role="tablist" aria-label="Activity" className="flex gap-1 border-b border-divider">
        {TABS.map((t) => {
          const selected = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              id={`activity-tab-${t.key}`}
              aria-selected={selected}
              aria-controls={`activity-panel-${t.key}`}
              onClick={() => onNavigateTab(t.key)}
              className={`-mb-px flex min-h-11 items-center gap-1.5 rounded-t border-b-2 px-2.5 text-sm hover:bg-hover sm:min-h-10 ${
                selected ? "border-base-content font-semibold" : "border-transparent text-base-content/60 hover:text-base-content"
              }`}
            >
              {t.label}
              {t.key === "jobs" && jobCount > 0 && <span className="font-normal text-base-content/50 tabular-nums">{jobCount}</span>}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" id={`activity-panel-${tab}`} aria-labelledby={`activity-tab-${tab}`}>
        {tab === "jobs" ? (
          <JobsPanel
            snapshot={feed.snapshot}
            error={feed.error}
            loading={feed.loading}
            paused={paused}
            onTogglePaused={() => setPaused((p) => !p)}
            onRefresh={feed.refresh}
            onSelectMeeting={onSelectMeeting}
          />
        ) : (
          <LogsView onSelectMeeting={onSelectMeeting} />
        )}
      </div>
    </div>
  );
}
