import type { ReactElement } from "react";
import { DebugQueuesPage } from "./DebugQueues";
import { LogsView } from "./Logs";

export type ActivityTab = "jobs" | "logs";

export function ActivityView({
  tab,
  onNavigateTab,
  onSelectMeeting,
}: {
  tab: ActivityTab;
  onNavigateTab: (tab: ActivityTab) => void;
  onSelectMeeting: (id: string) => void;
}): ReactElement {
  return (
    <div className="flex flex-col gap-6">
      <div role="tablist" aria-label="Activity" className="flex gap-1 border-b border-divider">
        {(["jobs", "logs"] as ActivityTab[]).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => onNavigateTab(t)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm capitalize ${tab === t ? "border-base-content font-semibold" : "border-transparent text-base-content/60 hover:text-base-content"}`}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === "jobs" ? <DebugQueuesPage /> : <LogsView onSelectMeeting={onSelectMeeting} />}
    </div>
  );
}
