import React, { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { Link2, RotateCw } from "lucide-react";
import { Combobox } from "../components/Combobox";
import { confirmAction, notify } from "../components/ui";
import { TRANSCRIBE_PROVIDER_OPTIONS, TRANSCRIPTION_AUTO_LABEL, TRANSCRIPT_PROVIDER_FILTER_OPTIONS, languageOptions } from "../components/OptionComboboxes";
import type { MeetingListItem, TranscriptionProgressUpdate } from "../api/types.ts";
import { MeetingsResponse, MEETINGS_PAGE_SIZE, formatDate, formatDuration } from "../lib/common";
import { Modal } from "./AppModals";
import { UploadAudioModal } from "./meetingModals";

export function MeetingsListView({ onSelectMeeting }: { onSelectMeeting: (id: string) => void }): ReactElement {
  const [meetings, setMeetings] = useState<MeetingListItem[]>([]);
  const [activeProgressMap, setActiveProgressMap] = useState<Record<string, TranscriptionProgressUpdate>>({});
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [mergingMeetings, setMergingMeetings] = useState(false);
  const [bulkNotice, setBulkNotice] = useState<string | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
  const meetingsRequestId = useRef(0);
  const meetingsRef = useRef<MeetingListItem[]>([]);
  const debouncedSearchRef = useRef("");
  const paginationRef = useRef<{ hasMore: boolean; nextOffset: number | null }>({ hasMore: false, nextOffset: null });

  useEffect(() => {
    meetingsRef.current = meetings;
  }, [meetings]);
  useEffect(() => {
    debouncedSearchRef.current = debouncedSearch;
  }, [debouncedSearch]);
  useEffect(() => {
    paginationRef.current = { hasMore, nextOffset };
  }, [hasMore, nextOffset]);

  const buildMeetingsUrl = (query: string, offset: number) => {
    const params = new URLSearchParams({
      limit: String(MEETINGS_PAGE_SIZE),
      offset: String(offset),
      // Full detail: the list view needs status, audioStatus, and artifact ids.
      includeDetails: "true",
    });
    const q = query.trim();
    if (q) params.set("search", q);
    return `/api/meetings?${params.toString()}`;
  };

  const applyPage = (data: MeetingsResponse, mode: "reset" | "append") => {
    const incoming = data.meetings || [];
    const pagination = data.pagination;
    const totalCount = pagination ? pagination.total : incoming.length;
    if (mode === "reset") {
      setMeetings(incoming);
      setTotal(totalCount);
      const more = pagination?.hasMore ?? incoming.length < totalCount;
      setHasMore(more);
      setNextOffset(pagination?.nextOffset ?? (more ? incoming.length : null));
    } else {
      const seen = new Set(meetingsRef.current.map((m) => m.id));
      const deduped = incoming.filter((m) => !seen.has(m.id));
      const merged = [...meetingsRef.current, ...deduped];
      setMeetings(merged);
      setTotal(totalCount);
      const more = pagination?.hasMore ?? merged.length < totalCount;
      setHasMore(more);
      setNextOffset(pagination?.nextOffset ?? (more ? merged.length : null));
    }
  };

  const fetchMeetings = async (opts?: { silent?: boolean }) => {
    const requestId = ++meetingsRequestId.current;
    if (!opts?.silent) {
      setLoading(true);
    }
    setLoadingMore(false);
    setError(null);
    try {
      const query = debouncedSearchRef.current;
      const [res, activeRes] = await Promise.all([
        fetch(buildMeetingsUrl(query, 0)),
        fetch("/api/transcriptions/active").catch(() => null)
      ]);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as MeetingsResponse;
      if (requestId !== meetingsRequestId.current) return;
      applyPage(data, "reset");
      if (activeRes && activeRes.ok) {
        const activeData = await activeRes.json();
        setActiveProgressMap(activeData.active || {});
      }
    } catch (err) {
      if (requestId !== meetingsRequestId.current) return;
      setError(err instanceof Error ? err.message : "Failed to load meetings");
    } finally {
      if (requestId === meetingsRequestId.current) {
        setLoading(false);
      }
    }
  };

  const loadMore = async () => {
    if (loadingMore || loading || !paginationRef.current.hasMore) return;
    const offset = paginationRef.current.nextOffset ?? meetingsRef.current.length;
    if (offset == null) return;
    const requestId = ++meetingsRequestId.current;
    setLoadingMore(true);
    try {
      const res = await fetch(buildMeetingsUrl(debouncedSearchRef.current, offset));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as MeetingsResponse;
      if (requestId !== meetingsRequestId.current) return;
      applyPage(data, "append");
    } catch (err) {
      if (requestId !== meetingsRequestId.current) return;
      setError(err instanceof Error ? err.message : "Failed to load more meetings");
    } finally {
      if (requestId === meetingsRequestId.current) {
        setLoadingMore(false);
      }
    }
  };

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    void fetchMeetings();
  }, [debouncedSearch]);

  useEffect(() => {
    if (!hasMore || loading || loadingMore) return;
    const el = loadMoreSentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore();
      },
      { rootMargin: "600px 0px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, loading, loadingMore, nextOffset, debouncedSearch, meetings.length]);

  const toggleSelectMeeting = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]));
  };

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds([]);
  };

  const handleSelectVisible = () => {
    setSelectedIds(meetings.map((m) => m.id));
  };

  const handleClearSelection = () => {
    setSelectedIds([]);
  };

  const handleMergeSelected = async () => {
    if (mergingMeetings) return;
    const ordered = meetings
      .filter((m) => selectedIds.includes(m.id))
      .slice()
      .sort((a, b) => a.startTime - b.startTime);
    if (ordered.length < 2) return;
    const target = ordered[0];
    const titles = ordered.map((m) => `“${m.title}”`).join(", ");
    const others = ordered.length - 1;
    if (
      !(await confirmAction({
        title: `Merge ${ordered.length} meetings`,
        message: `Merge ${titles} into “${target.title}” in chronological order? Audio and transcripts are joined without re-transcription, and the other ${others} meeting${others === 1 ? "" : "s"} will be permanently deleted. Summaries are dropped because they only describe the separate clips.`,
        confirmLabel: "Merge & delete originals",
        danger: true
      }))
    ) {
      return;
    }
    setMergingMeetings(true);
    setError(null);
    try {
      const res = await fetch("/api/meetings/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meetingIds: ordered.map((m) => m.id) })
      });
      const data = (await res.json().catch(() => ({}))) as { meeting?: { id?: string }; error?: string };
      if (!res.ok) throw new Error(data.error || `Failed to merge meetings (HTTP ${res.status})`);
      const mergedId = data.meeting?.id;
      setSelectedIds([]);
      setSelectMode(false);
      setMeetings((prev) => prev.filter((m) => m.id === mergedId || !ordered.some((o) => o.id === m.id)));
      setTotal((t) => Math.max(0, t - others));
      await fetchMeetings({ silent: true });
      if (mergedId) onSelectMeeting(mergedId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to merge meetings");
    } finally {
      setMergingMeetings(false);
    }
  };

  const handleDeleteMeeting = async (id: string, title: string) => {
    if (!(await confirmAction({ title: "Delete meeting", message: `Are you sure you want to delete meeting "${title}"? This will permanently remove its recordings, transcripts, and summaries.`, confirmLabel: "Delete", danger: true }))) {
      return;
    }
    try {
      const res = await fetch(`/api/meetings/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `Failed to delete meeting (HTTP ${res.status})`);
      }
      setMeetings((prev) => prev.filter((m) => m.id !== id));
      setTotal((t) => Math.max(0, t - 1));
      setSelectedIds((prev) => prev.filter((sid) => sid !== id));
      if (paginationRef.current.hasMore) {
        setNextOffset(Math.max(0, meetingsRef.current.length - 1));
      }
      setActiveProgressMap((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    }
  };

  // Poll active transcriptions every 2.5s if any meeting is processing.
  // Refresh the first page and merge into the loaded list so infinite
  // scroll position is preserved (the backend caps pages at 100).
  useEffect(() => {
    const hasProcessing = meetings.some((m) => m.status === "processing") || Object.keys(activeProgressMap).length > 0;
    if (!hasProcessing) return;

    const interval = setInterval(async () => {
      try {
        const [activeRes, meetingsRes] = await Promise.all([
          fetch("/api/transcriptions/active"),
          fetch(buildMeetingsUrl(debouncedSearchRef.current, 0))
        ]);
        if (activeRes.ok) {
          const activeData = await activeRes.json();
          setActiveProgressMap(activeData.active || {});
        }
        if (meetingsRes.ok) {
          const mData = (await meetingsRes.json()) as MeetingsResponse;
          const fresh = mData.meetings || [];
          const freshTotal = mData.pagination ? mData.pagination.total : fresh.length;
          const prev = meetingsRef.current;
          if (prev.length === 0) {
            applyPage(mData, "reset");
          } else {
            const freshById = new Map(fresh.map((m) => [m.id, m]));
            const prevIds = new Set(prev.map((m) => m.id));
            const newcomers = fresh.filter((m) => !prevIds.has(m.id));
            const combined = [...newcomers, ...prev.map((m) => freshById.get(m.id) ?? m)];
            setMeetings(combined);
            setTotal(freshTotal);
            const more = combined.length < freshTotal;
            setHasMore(more);
            setNextOffset(more ? combined.length : null);
          }
        }
      } catch {}
    }, 2500);

    return () => clearInterval(interval);
  }, [meetings, activeProgressMap, debouncedSearch]);

  return (
    <div className="space-y-5 sm:space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Meetings</h1>
          <p className="mt-1 text-sm text-base-content/70">Recorded and ingested audio archive</p>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:gap-3">
          <input
            type="search"
            placeholder="Search meetings…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input input-md w-full sm:w-64"
          />
          <button
            type="button"
            onClick={() => {
              if (selectMode) {
                exitSelectMode();
              } else {
                setSelectMode(true);
              }
            }}
            aria-pressed={selectMode}
            className={`flex min-h-[44px] items-center justify-center rounded-lg border px-4 py-2 text-sm font-semibold transition shrink-0 ${
              selectMode
                ? "border-primary bg-primary/10 text-primary"
                : "border-base-300 text-base-content hover:border-base-300 hover:text-white"
            }`}
          >
            {selectMode ? "Done" : "Select"}
          </button>
          <button
            type="button"
            onClick={() => {
              setBulkNotice(null);
              setShowBulkModal(true);
            }}
            className={`btn min-h-[44px] flex-1 sm:flex-none gap-2 shrink-0 ${
              selectMode && selectedIds.length > 0
                ? "btn-primary"
                : "btn-primary btn-soft"
            }`}
            title="Re-transcribe many meetings with one engine"
          >
            <span><RotateCw className="h-4 w-4 shrink-0" aria-hidden="true" /></span> {selectMode && selectedIds.length > 0 ? `Re-transcribe ${selectedIds.length}` : "Bulk re-transcribe"}
          </button>
          <button
            type="button"
            onClick={() => setShowUploadModal(true)}
            className="btn btn-primary flex min-h-[44px] flex-1 sm:flex-none items-center justify-center gap-2 shrink-0"
          >
            <span>+</span> Upload Audio
          </button>
        </div>
      </div>

      {bulkNotice && (
        <div className="rounded-xl border border-primary bg-primary/10 p-4 text-sm text-primary">{bulkNotice}</div>
      )}

      {selectMode && !loading && !error && meetings.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-base-300 bg-base-200/60 px-3 py-2 text-xs text-base-content/70 sm:gap-3">
          <span className={`mr-auto ${selectedIds.length > 0 ? "font-semibold text-primary" : ""}`}>
            {selectedIds.length > 0 ? `${selectedIds.length} selected` : "Tap meetings to select"}
          </span>
          <button type="button" onClick={handleSelectVisible} className="btn min-h-[36px] hover:border-primary/60 hover:text-primary">
            Select visible ({meetings.length})
          </button>
          {selectedIds.length > 0 && (
            <button type="button" onClick={handleClearSelection} className="btn min-h-[36px] hover:border-error/60 hover:text-error">
              Clear
            </button>
          )}
          {selectedIds.length >= 2 && (
            <button
              type="button"
              onClick={() => void handleMergeSelected()}
              disabled={mergingMeetings}
              className="btn min-h-[36px] gap-1.5 border-primary/60 text-primary hover:bg-primary/10"
              title="Join the selected meetings (chronological) into one and delete the rest"
            >
              <Link2 className="h-4 w-4 shrink-0" aria-hidden="true" />
              {mergingMeetings ? "Merging…" : `Merge ${selectedIds.length}`}
            </button>
          )}
        </div>
      )}

      {loading && <p className="text-base-content/70">Loading meetings…</p>}
      {error && <div className="rounded-xl border border-error bg-error/10 p-4 text-error">{error}</div>}

      {!loading && !error && meetings.length === 0 && (
        <div className="rounded-2xl border border-dashed border-base-300 bg-base-200/40 py-16 text-center">
          <p className="text-base-content/70">No meetings found.</p>
        </div>
      )}

      {!loading && !error && meetings.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {meetings.map((meeting) => {
            const selected = selectedIds.includes(meeting.id);
            const progress = activeProgressMap[meeting.id];
            const audioPending = meeting.audioStatus === "retrieving" || meeting.audioStatus === "missing";
            return (
              <div
                key={meeting.id}
                onClick={() => (selectMode ? toggleSelectMeeting(meeting.id) : onSelectMeeting(meeting.id))}
                aria-selected={selectMode ? selected : undefined}
                className={`group flex h-full cursor-pointer flex-col gap-2.5 rounded-xl border p-4 sm:p-5 shadow-sm transition ${
                  selectMode && selected
                    ? "border-primary bg-primary/5"
                    : audioPending
                    ? "border-base-300 bg-base-200/60 opacity-60 saturate-50 hover:border-info/50 hover:opacity-80"
                    : "border-base-300 bg-base-200/90 hover:border-primary/60 hover:bg-base-200"
                }`}
              >
                <div className="flex items-start gap-2">
                  {selectMode && (
                    <span className="-ml-2 -mt-1.5 flex h-11 w-11 shrink-0 items-center justify-center">
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleSelectMeeting(meeting.id)}
                        onClick={(e) => e.stopPropagation()}
                        className="h-5 w-5 accent-primary"
                        aria-label={`Select meeting ${meeting.title}`}
                      />
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <h2 className="line-clamp-2 break-words text-lg font-semibold leading-snug text-base-content group-hover:text-primary transition">
                      {meeting.title}
                    </h2>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-base-content/70">
                      <span>{formatDate(meeting.startTime)}</span>
                      <span>•</span>
                      <span>{formatDuration(meeting.endTime - meeting.startTime)}</span>
                      <span>•</span>
                      <span className="capitalize">{meeting.source}</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleDeleteMeeting(meeting.id, meeting.title);
                    }}
                    className="btn btn-circle btn-ghost -mr-2 -mt-1.5 flex shrink-0 items-center justify-center text-base-content/50 hover:bg-error/10 hover:text-error min-h-11 min-w-11"
                    title="Delete meeting"
                    aria-label={`Delete meeting ${meeting.title}`}
                  >
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="3 6 5 6 21 6"></polyline>
                      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    </svg>
                  </button>
                </div>

                <div className="mt-auto flex flex-wrap items-center gap-1.5">
                  {meeting.audioStatus === "retrieving" && !progress ? (
                    <span className="badge badge-info badge-soft gap-1.5 px-3 py-1 animate-pulse">
                      <span className="status status-info status-xs animate-ping" />
                      Retrieving audio…
                    </span>
                  ) : meeting.audioStatus === "missing" && !progress ? (
                    <span className="badge badge-error badge-soft gap-1.5 px-3 py-1">
                      Audio missing
                    </span>
                  ) : progress ? (
                    <div className="badge badge-warning badge-soft gap-2 px-3 py-1">
                      <span className="status status-warning status-xs animate-ping" />
                      <span className="font-semibold">{progress.stage} ({Math.round(progress.percent)}%)</span>
                    </div>
                  ) : (
                    <span
                      className={`badge badge-soft capitalize ${
                        meeting.status === "ready"
                          ? "badge-success"
                          : meeting.status === "processing"
                          ? "badge-warning animate-pulse"
                          : "badge-neutral"
                      }`}
                    >
                      {meeting.status}
                    </span>
                  )}
                  {meeting.primaryTranscriptArtifactId && (
                    <span className="rounded-full bg-base-300 px-2.5 py-1 text-xs text-base-content">
                      Transcript
                    </span>
                  )}
                  {meeting.tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-full border border-base-300 bg-base-300/80 px-2 py-0.5 text-[11px] text-base-content"
                    >
                      {tag}
                    </span>
                  ))}
                </div>

                {progress && (
                  <div className="space-y-1">
                    <div className="flex justify-between gap-2 text-[11px] text-base-content/70">
                      <span className="truncate max-w-[80%]">{progress.message}</span>
                      <span className="font-mono text-warning font-bold">{Math.round(progress.percent)}%</span>
                    </div>
                    <progress className="progress progress-warning w-full" value={Math.max(5, progress.percent)} max={100} aria-label="Meeting progress" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!loading && !error && meetings.length > 0 && (
        <div className="flex flex-col items-center gap-3 pt-1">
          <p className="text-xs text-base-content/50" aria-live="polite">
            Showing {meetings.length} of {total} meeting{total === 1 ? "" : "s"}
          </p>
          {hasMore && !loadingMore && (
            <button
              type="button"
              onClick={() => void loadMore()}
              className="btn min-h-[44px] font-semibold hover:border-primary/60 hover:text-primary"
            >
              Load more
            </button>
          )}
          {loadingMore && <p className="text-xs text-base-content/50">Loading more meetings…</p>}
          {!hasMore && total > 0 && (
            <p className="text-xs text-base-content/50">You&apos;ve reached the end of the list.</p>
          )}
          <div ref={loadMoreSentinelRef} aria-hidden="true" className="h-1 w-full" />
        </div>
      )}

      {showBulkModal && (
        <BulkTranscribeModal
          selectedIds={selectedIds}
          listSearch={search}
          onClose={() => setShowBulkModal(false)}
          onQueued={(summary, queuedIds) => {
            setShowBulkModal(false);
            setBulkNotice(summary);
            if (queuedIds.length > 0) {
              setSelectedIds([]);
            }
            void fetchMeetings({ silent: true });
          }}
        />
      )}

      {showUploadModal && (
        <UploadAudioModal
          onClose={() => setShowUploadModal(false)}
          onUploaded={(meetingId) => {
            setShowUploadModal(false);
            onSelectMeeting(meetingId);
          }}
        />
      )}
    </div>
  );
}

export interface BulkQueueResult {
  bulkId: string;
  provider: string;
  total: number;
  queued: number;
  alreadyRunning: number;
  skipped: number;
  results: Array<{ meetingId: string; status: string; jobId?: string | null; alreadyRunning?: boolean; error?: string | null }>;
}

export function BulkTranscribeModal({
  selectedIds,
  listSearch,
  onClose,
  onQueued
}: {
  selectedIds: string[];
  listSearch: string;
  onClose: () => void;
  onQueued: (summary: string, queuedIds: string[]) => void;
}): ReactElement {
  const [scope, setScope] = useState<"selected" | "filtered">(selectedIds.length > 0 ? "selected" : "filtered");
  const [provider, setProvider] = useState<string>("assemblyai");
  const [language, setLanguage] = useState("");
  const [force, setForce] = useState(true);
  const [search, setSearch] = useState(listSearch);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [currentProvider, setCurrentProvider] = useState("any");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BulkQueueResult | null>(null);

  useEffect(() => {
    if (selectedIds.length > 0) setScope("selected");
  }, [selectedIds.length]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const filters: Record<string, unknown> = {};
      if (scope === "filtered") {
        if (search.trim()) filters.search = search.trim();
        if (startDate) {
          const ms = new Date(`${startDate}T00:00:00`).getTime();
          if (!Number.isNaN(ms)) filters.startTime = ms;
        }
        if (endDate) {
          const ms = new Date(`${endDate}T23:59:59.999`).getTime();
          if (!Number.isNaN(ms)) filters.endTime = ms;
        }
        if (currentProvider && currentProvider !== "any") filters.currentProvider = currentProvider;
      }
      const body: Record<string, unknown> = { provider, force };
      if (language) body.language = language;
      if (scope === "selected") {
        body.meetingIds = selectedIds;
      } else {
        body.filters = filters;
      }
      const res = await fetch("/api/meetings/bulk-transcribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
      const queued = data as BulkQueueResult;
      setResult(queued);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const failures = (result?.results || []).filter((r) => r.status === "skipped").slice(0, 8);

  return (
    <Modal onClose={onClose} title={"Bulk re-transcribe"} ariaLabel="Bulk re-transcribe meetings" maxWidth="max-w-lg">
      {error && <div className="rounded-xl border border-error bg-error/10 p-3 text-xs text-error">{error}</div>}

      {result ? (
        <div className="space-y-4 text-sm">
          <div className="rounded-xl border border-primary bg-primary/10 p-4 text-primary">
            Queued {result.queued} of {result.total} meeting{result.total === 1 ? "" : "s"} with <strong>{result.provider}</strong>
            {result.alreadyRunning > 0 && <span> ({result.alreadyRunning} already running)</span>}
            {result.skipped > 0 && <span> ({result.skipped} skipped)</span>}. Watch progress on the meetings list.
          </div>
          {failures.length > 0 && (
            <ul className="space-y-1 text-xs text-base-content/70">
              {failures.map((f) => (
                <li key={f.meetingId} className="rounded-lg border border-base-300 bg-base-100/60 px-3 py-2">
                  <span className="font-mono text-base-content">{f.meetingId.slice(0, 8)}…</span>: {f.error || "skipped"}
                </li>
              ))}
            </ul>
          )}
          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={() => onQueued(
                `Bulk job ${result.bulkId}: queued ${result.queued}/${result.total} with ${result.provider}.`,
                (result.results || []).filter((r) => r.status === "running").map((r) => r.meetingId)
              )}
              className="btn btn-primary min-h-11"
            >
              Done
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4 text-sm">
          <div className="grid gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-base-content/70">Which meetings?</span>
            <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-base-300 bg-base-100/60 px-3 py-2.5 hover:border-base-300 transition">
              <input type="radio" name="bulk-scope" checked={scope === "selected"} onChange={() => setScope("selected")} disabled={selectedIds.length === 0} className="accent-primary" />
              <span>Selected meetings ({selectedIds.length}){selectedIds.length === 0 && " — tick meetings in the list first"}</span>
            </label>
            <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-base-300 bg-base-100/60 px-3 py-2.5 hover:border-base-300 transition">
              <input type="radio" name="bulk-scope" checked={scope === "filtered"} onChange={() => setScope("filtered")} className="accent-primary" />
              <span>All meetings matching filters (whole library, server-side)</span>
            </label>
          </div>

          {scope === "filtered" && (
            <div className="space-y-3 rounded-xl border border-base-300 bg-base-100/60 p-4">
              <input
                type="text"
                placeholder="Search title, tags, transcript…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="input input-md w-full"
              />
              <div className="grid grid-cols-2 gap-3">
                <label className="space-y-1 text-xs text-base-content/70">
                  <span>From date</span>
                  <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="input input-md w-full" />
                </label>
                <label className="space-y-1 text-xs text-base-content/70">
                  <span>To date</span>
                  <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="input input-md w-full" />
                </label>
              </div>
              <label className="space-y-1 text-xs text-base-content/70">
                <span>Current transcript provider</span>
                <Combobox
                  value={currentProvider}
                  onChange={setCurrentProvider}
                  placeholder="Select provider filter…"
                  ariaLabel="Current transcript provider"
                  searchPlaceholder="Search providers…"
                  options={TRANSCRIPT_PROVIDER_FILTER_OPTIONS}
                />
              </label>
            </div>
          )}

          <label className="space-y-1 text-xs text-base-content/70">
            <span className="text-xs font-semibold uppercase tracking-wider">Transcribe with</span>
            <Combobox
              value={provider}
              onChange={setProvider}
              placeholder="Select engine…"
              ariaLabel="Transcribe with"
              searchPlaceholder="Search engines…"
              options={TRANSCRIBE_PROVIDER_OPTIONS}
            />
          </label>

          <label className="space-y-1 text-xs text-base-content/70">
            <span className="text-xs font-semibold uppercase tracking-wider">Language</span>
            <Combobox
              value={language}
              onChange={setLanguage}
              placeholder="Select language…"
              ariaLabel="Transcription language"
              searchPlaceholder="Search languages…"
              options={languageOptions("Default from settings", TRANSCRIPTION_AUTO_LABEL)}
            />
          </label>

          <label className="flex cursor-pointer items-center gap-2 text-xs text-base-content">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} className="checkbox checkbox-sm" />
            Force re-transcribe even if already done (recommended when switching engines)
          </label>

          <div className="flex justify-end gap-3 pt-1">
            <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-base-content/70 hover:text-base-content">Cancel</button>
            <button
              type="submit"
              disabled={submitting || (scope === "selected" && selectedIds.length === 0)}
              className="btn btn-primary min-h-11"
            >
              {submitting ? "Queueing…" : scope === "selected" ? `Queue ${selectedIds.length} meeting${selectedIds.length === 1 ? "" : "s"}` : "Queue matching meetings"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
