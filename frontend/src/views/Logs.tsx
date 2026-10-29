import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { ChevronDown, ChevronRight, Pause, Play, RotateCw, Search, Trash2, X } from "lucide-react";
import { Combobox } from "../components/Combobox";
import { confirmAction } from "../components/ui";
import { logCategoryOptions } from "../components/OptionComboboxes";
import type { LogItem, LogLevel, LogListResponse } from "../api/types.ts";
import { formatLogTimestamp } from "./Usage";

const LEVELS: Array<{ value: LogLevel; label: string; title: string }> = [
  { value: "debug", label: "All", title: "All levels (debug and above)" },
  { value: "info", label: "Info+", title: "Info, warnings and errors" },
  { value: "warn", label: "Warnings", title: "Warnings and errors" },
  { value: "error", label: "Errors", title: "Errors only" },
];

const LEVEL_TAG: Record<string, string> = {
  debug: "tag-gray",
  info: "tag-blue",
  warn: "tag-yellow",
  error: "tag-red",
};

const btnGhost =
  "inline-flex min-h-11 items-center gap-1.5 rounded-md px-2.5 text-sm text-base-content/70 hover:bg-hover hover:text-base-content disabled:opacity-50 sm:min-h-[34px]";

function formatLogTime(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(d)} ${time}`;
}

function LogRow({
  log,
  expanded,
  onToggle,
  onSelectMeeting,
}: {
  log: LogItem;
  expanded: boolean;
  onToggle: () => void;
  onSelectMeeting: (id: string) => void;
}): ReactElement {
  const detailCount = log.details ? Object.keys(log.details).length : 0;
  const meetingId = log.meetingId;
  return (
    <li
      className={`border-b border-divider px-3 py-2 text-sm last:border-b-0 sm:px-3.5 ${
        log.level === "error" ? "bg-error/5" : log.level === "warn" ? "bg-warning/5" : ""
      }`}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 xl:grid xl:grid-cols-[4.75rem_6.5rem_7.5rem_minmax(0,1fr)_minmax(0,11rem)] xl:items-start">
        <span className={`tag ${LEVEL_TAG[log.level] ?? "tag-gray"} min-h-5 px-1.5 text-[11px] font-semibold uppercase`}>{log.level}</span>
        <time
          dateTime={new Date(log.createdAt).toISOString()}
          title={formatLogTimestamp(log.createdAt)}
          className="font-mono text-xs tabular-nums text-base-content/60 xl:pt-0.5"
        >
          {formatLogTime(log.createdAt)}
        </time>
        <span className="min-w-0 max-w-[10rem] truncate text-base-content/60 xl:max-w-none" title={log.category}>
          {log.category}
        </span>
        <div className="order-last w-full min-w-0 xl:order-none xl:w-auto">
          <p className="break-words leading-snug">{log.message}</p>
          {detailCount > 0 && (
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={expanded}
              className="-ml-1 mt-0.5 inline-flex min-h-11 items-center gap-0.5 rounded px-1 text-xs text-base-content/55 hover:bg-hover hover:text-base-content sm:min-h-6"
            >
              {expanded ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
              {expanded ? "Hide details" : `Details (${detailCount})`}
            </button>
          )}
        </div>
        {meetingId ? (
          <button
            type="button"
            onClick={() => onSelectMeeting(meetingId)}
            title={`Open meeting ${log.meetingTitle || meetingId}`}
            className="ml-auto min-h-11 max-w-[14rem] truncate text-left text-base-content/60 underline sm:min-h-0 xl:ml-0 xl:max-w-full decoration-base-300 underline-offset-2 hover:text-base-content"
          >
            {log.meetingTitle || meetingId.slice(0, 8)}
          </button>
        ) : (
          <span className="hidden xl:block" />
        )}
      </div>
      {expanded && log.details && (
        <pre className="mt-2 overflow-x-auto rounded-md bg-base-200 p-3 font-mono text-[11px] leading-snug text-base-content/85 xl:ml-[21rem]">
          {JSON.stringify(log.details, null, 2)}
        </pre>
      )}
    </li>
  );
}

export function LogsView({ onSelectMeeting }: { onSelectMeeting: (id: string) => void }): ReactElement {
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [selectedLevel, setSelectedLevel] = useState<LogLevel>("debug");
  const [selectedCategory, setSelectedCategory] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [loading, setLoading] = useState(false);
  const [expandedLogIds, setExpandedLogIds] = useState<Set<string>>(new Set());

  const fetchLogs = async () => {
    try {
      const params = new URLSearchParams();
      if (selectedLevel) params.set("level", selectedLevel);
      if (selectedCategory) params.set("category", selectedCategory);
      if (searchQuery.trim()) params.set("search", searchQuery.trim());
      params.set("limit", "200");

      const res = await fetch(`/api/logs?${params.toString()}`);
      if (res.ok) {
        const data = (await res.json()) as LogListResponse;
        setLogs(data.logs);
        setTotalCount(data.pagination.total);
        if (data.categories && data.categories.length > 0) {
          setCategories(data.categories);
        }
      }
    } catch {
      // Ignore network errors on background poll
    }
  };

  useEffect(() => {
    setLoading(true);
    void fetchLogs().finally(() => setLoading(false));
  }, [selectedLevel, selectedCategory, searchQuery]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      void fetchLogs();
    }, 3000);
    return () => clearInterval(interval);
  }, [autoRefresh, selectedLevel, selectedCategory, searchQuery]);

  const toggleExpand = (id: string) => {
    setExpandedLogIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleClearLogs = async () => {
    if (!(await confirmAction({ title: "Clear logs", message: "Are you sure you want to clear all stored system logs?", confirmLabel: "Clear", danger: true }))) {
      return;
    }
    try {
      const res = await fetch("/api/logs", { method: "DELETE" });
      if (res.ok) {
        await fetchLogs();
      }
    } catch {
      // ignore
    }
  };

  const filtered = selectedLevel !== "debug" || !!selectedCategory || !!searchQuery.trim();

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label="Minimum log level" className="flex rounded-lg bg-hover p-[3px]">
          {LEVELS.map((l) => {
            const on = selectedLevel === l.value;
            return (
              <button
                key={l.value}
                type="button"
                role="radio"
                aria-checked={on}
                title={l.title}
                onClick={() => setSelectedLevel(l.value)}
                className={`min-h-10 rounded-md px-2.5 text-[13px] sm:min-h-7 ${
                  on ? "bg-base-100 font-semibold shadow-sm" : "text-base-content/70 hover:text-base-content"
                }`}
              >
                {l.label}
              </button>
            );
          })}
        </div>
        <div className="w-full sm:w-48">
          <Combobox
            value={selectedCategory}
            onChange={setSelectedCategory}
            placeholder="All categories"
            ariaLabel="Log category"
            searchPlaceholder="Search categories…"
            emptyText="No categories match your search."
            options={logCategoryOptions(categories)}
          />
        </div>
        <label className="flex min-h-11 min-w-0 flex-[1_1_220px] items-center gap-1.5 rounded-md bg-hover px-2.5 text-base-content/60 sm:min-h-[34px] sm:max-w-sm">
          <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search message, meeting or detail"
            aria-label="Search logs"
            className="w-full min-w-0 bg-transparent text-sm text-base-content outline-none placeholder:text-base-content/50 [&::-webkit-search-cancel-button]:hidden"
          />
          {searchQuery && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setSearchQuery("")}
              className="-mr-1.5 inline-flex min-h-11 min-w-11 items-center justify-center rounded hover:text-base-content sm:min-h-6 sm:min-w-6"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </label>
        <span className="flex-1" />
        <span className={`inline-flex items-center gap-1.5 text-[13px] font-medium ${autoRefresh ? "text-primary" : "text-base-content/60"}`}>
          <span className={`h-2 w-2 rounded-full ${autoRefresh ? "animate-pulse bg-primary" : "bg-base-content/40"}`} aria-hidden="true" />
          {autoRefresh ? "Live" : "Paused"}
        </span>
        <button type="button" className={btnGhost} onClick={() => setAutoRefresh(!autoRefresh)} aria-pressed={!autoRefresh} title={autoRefresh ? "Stop refreshing every 3 s" : "Refresh every 3 s"}>
          {autoRefresh ? <Pause className="h-4 w-4" aria-hidden="true" /> : <Play className="h-4 w-4" aria-hidden="true" />}
          {autoRefresh ? "Pause" : "Resume"}
        </button>
        <button type="button" className={btnGhost} onClick={() => void fetchLogs()} disabled={loading} aria-label="Refresh logs" title="Refresh now">
          <RotateCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
        </button>
        <button type="button" className={`${btnGhost} hover:text-error`} onClick={() => void handleClearLogs()}>
          <Trash2 className="h-4 w-4" aria-hidden="true" />
          Clear
        </button>
      </div>

      <p className="text-xs text-base-content/50">
        Showing {logs.length} of {totalCount} logs
      </p>

      <div className="overflow-hidden rounded-box border border-base-300">
        {logs.length === 0 ? (
          <p className="p-12 text-center text-sm text-base-content/60">
            {loading ? "Loading logs…" : filtered ? "No log entries match these filters." : "No logs yet."}
          </p>
        ) : (
          <ul>
            {logs.map((log) => (
              <LogRow
                key={log.id}
                log={log}
                expanded={expandedLogIds.has(log.id)}
                onToggle={() => toggleExpand(log.id)}
                onSelectMeeting={onSelectMeeting}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
