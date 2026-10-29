import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { ChevronDown, ChevronUp, Pause, Play, RotateCw, Trash2, X } from "lucide-react";
import { Combobox } from "../components/Combobox";
import { confirmAction } from "../components/ui";
import { LOG_LEVEL_OPTIONS, logCategoryOptions } from "../components/OptionComboboxes";
import type { LogItem, LogLevel, LogListResponse } from "../api/types.ts";
import { formatLogTimestamp } from "./Usage";

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

  return (
    <div className="space-y-6">
      {/* Header & Controls */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-base-content">System & Job Logs</h1>
            {autoRefresh && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 border border-primary/30 px-2.5 py-0.5 text-[10px] font-semibold text-primary">
                <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
                Live (3s)
              </span>
            )}
          </div>
          <p className="text-sm text-base-content/70">
            Real-time execution trace for ingestion, Speechmatics/local transcription, diarization, speaker enrollment, and AI summarization.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:gap-2.5">
          <button
            type="button"
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`min-h-[44px] flex-1 rounded-lg border px-3 py-1.5 text-sm font-medium transition sm:min-h-0 sm:flex-none sm:text-xs ${
              autoRefresh
                ? "border-primary/40 bg-primary/10 text-primary hover:bg-primary/20"
                : "border-base-300 bg-base-300 text-base-content/70 hover:text-base-content"
            }`}
          >
            {autoRefresh ? <><Pause className="h-4 w-4 shrink-0" aria-hidden="true" /> Pause Stream</> : <><Play className="h-4 w-4 shrink-0" aria-hidden="true" /> Auto-Refresh</>}
          </button>
          <button
            type="button"
            onClick={() => void fetchLogs()}
            disabled={loading}
            className="btn min-h-[44px] flex-1 bg-base-300 sm:min-h-0 sm:flex-none sm:text-xs"
          >
            {loading ? "Refreshing…" : <><RotateCw className="h-4 w-4 shrink-0" aria-hidden="true" /> Refresh</>}
          </button>
          <button
            type="button"
            onClick={() => void handleClearLogs()}
            className="btn btn-error btn-soft min-h-[44px] flex-1 border border-error/30 text-error hover:bg-error/20 sm:min-h-0 sm:flex-none sm:text-xs"
          >
            <Trash2 className="h-4 w-4 shrink-0" aria-hidden="true" /> Clear
          </button>
        </div>
      </div>

      {/* Filter Toolbar */}
      <div className="flex flex-col gap-3 rounded-xl border border-base-300 bg-base-200/60 p-3.5 sm:flex-row sm:flex-wrap sm:items-center">
        {/* Severity Level Filter */}
        <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-2">
          <span className="text-xs font-medium text-base-content/70">
            Min Level:
          </span>
          <div className="w-full sm:w-56">
            <Combobox
              value={selectedLevel}
              onChange={(v) => setSelectedLevel(v as LogLevel)}
              placeholder="Select level…"
              ariaLabel="Minimum log level"
              searchPlaceholder="Search levels…"
              options={LOG_LEVEL_OPTIONS}
            />
          </div>
        </div>

        {/* Category Filter */}
        <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-2">
          <span className="text-xs font-medium text-base-content/70">
            Category:
          </span>
          <div className="w-full sm:w-56">
            <Combobox
              value={selectedCategory}
              onChange={setSelectedCategory}
              placeholder="Select category…"
              ariaLabel="Log category"
              searchPlaceholder="Search categories…"
              emptyText="No categories match your search."
              options={logCategoryOptions(categories)}
            />
          </div>
        </div>

        {/* Search Input */}
        <div className="flex flex-1 min-w-0 items-center gap-2 sm:min-w-[200px]">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search logs by message, meeting, or detail…"
            className="input input-md w-full py-1.5 sm:text-xs"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center text-base-content/50 hover:text-base-content text-xs sm:min-h-0 sm:min-w-0 sm:px-1"
            >
              <X className="h-4 w-4 shrink-0" aria-hidden="true" />
            </button>
          )}
        </div>

        {/* Total Badge */}
        <span className="text-[11px] font-mono text-base-content/50">
          Showing {logs.length} of {totalCount} logs
        </span>
      </div>

      {/* Logs Table / List */}
      <div className="rounded-xl border border-base-300 bg-base-200/60 backdrop-blur overflow-hidden">
        {logs.length === 0 ? (
          <div className="p-12 text-center text-base-content/50 text-sm">
            No log entries match the current filter criteria.
          </div>
        ) : (
          <div className="divide-y divide-base-300/60 font-mono text-xs">
            {logs.map((log) => {
              const isExpanded = expandedLogIds.has(log.id);
              const hasDetails = log.details && Object.keys(log.details).length > 0;

              return (
                <div
                  key={log.id}
                  className={`p-3.5 transition hover:bg-base-300/30 ${
                    log.level === "error"
                      ? "bg-error/5"
                      : log.level === "warn"
                      ? "bg-warning/5"
                      : ""
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2.5">
                      {/* Level Badge */}
                      <span
                        className={`rounded px-2 py-0.5 font-bold uppercase tracking-wider text-[10px] border ${
                          log.level === "error"
                            ? "border-error/40 bg-error/10 text-error"
                            : log.level === "warn"
                            ? "border-warning/40 bg-warning/10 text-warning"
                            : log.level === "info"
                            ? "border-info/40 bg-info/10 text-info"
                            : "border-base-300 bg-base-300/80 text-base-content/70"
                        }`}
                      >
                        {log.level}
                      </span>

                      {/* Category Badge */}
                      <span className="rounded bg-base-300 px-2 py-0.5 text-[10px] text-primary border border-base-300">
                        {log.category}
                      </span>

                      {/* Timestamp */}
                      <span className="text-base-content/50 text-[11px]">
                        {formatLogTimestamp(log.createdAt)}
                      </span>

                      {/* Linked Meeting */}
                      {log.meetingId && (
                        <button
                          type="button"
                          onClick={() => onSelectMeeting(log.meetingId!)}
                          className="rounded bg-base-300/60 px-2 py-0.5 text-[10px] text-accent hover:bg-accent/20 transition border border-accent/30 truncate max-w-[220px]"
                          title={`Open meeting ${log.meetingTitle || log.meetingId}`}
                        >
                          📌 {log.meetingTitle || log.meetingId.slice(0, 8)}
                        </button>
                      )}
                    </div>

                    {/* Details toggle */}
                    {hasDetails && (
                      <button
                        type="button"
                        onClick={() => toggleExpand(log.id)}
                        className="rounded border border-base-300 bg-base-300/60 px-2 py-0.5 text-[10px] text-base-content hover:bg-base-300 transition"
                      >
                        {isExpanded ? <><ChevronUp className="h-3 w-3 shrink-0" aria-hidden="true" /> Hide Details</> : <><ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" /> Details ({Object.keys(log.details!).length})</>}
                      </button>
                    )}
                  </div>

                  {/* Message */}
                  <div className="mt-2 text-base-content font-sans text-xs sm:text-sm leading-relaxed">
                    {log.message}
                  </div>

                  {/* Expanded JSON details */}
                  {isExpanded && log.details && (
                    <div className="mt-3 rounded-lg border border-base-300 bg-base-100 p-3 text-xs text-base-content overflow-x-auto">
                      <pre className="font-mono text-[11px] leading-snug">
                        {JSON.stringify(log.details, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
