import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { CheckSquare, LayoutGrid, Link2, MoreHorizontal, Plus, RotateCw, Search, Table2, Trash2, X } from "lucide-react";
import { Combobox } from "../components/Combobox";
import { confirmAction, notify } from "../components/ui";
import { TRANSCRIBE_PROVIDER_OPTIONS, TRANSCRIPTION_AUTO_LABEL, TRANSCRIPT_PROVIDER_FILTER_OPTIONS, languageOptions } from "../components/OptionComboboxes";
import type { MeetingListItem, TranscriptionProgressUpdate } from "../api/types.ts";
import { MeetingsResponse, MEETINGS_PAGE_SIZE } from "../lib/common";
import { Modal } from "./AppModals";
import { UploadAudioModal } from "./meetingModals";
import {
  ClearFiltersButton,
  EMPTY_FILTERS,
  FilterChips,
  SortMenu,
  dateFilterStart,
  hasActiveFilters,
  sortMeetings,
} from "./meetings-list/Filters";
import type { MeetingFilters, SortKey } from "./meetings-list/Filters";
import { MeetingGallery, MeetingMobileList, MeetingTable, MeetingsSkeleton } from "./meetings-list/MeetingViews";
import { MenuItem, Popover } from "./meetings-list/Popover";
import { sourceLabel } from "./meetings-list/format";

type ViewMode = "table" | "gallery";
const VIEW_STORAGE_KEY = "olive.meetings.view";

function readStoredView(): ViewMode {
  try {
    const v = window.localStorage.getItem(VIEW_STORAGE_KEY);
    return v === "gallery" ? "gallery" : "table";
  } catch {
    return "table";
  }
}

function storeView(view: ViewMode): void {
  try {
    window.localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // Storage unavailable (private mode, blocked site data): keep the in-memory choice.
  }
}

function useIsMobile(): boolean {
  const query = "(max-width: 639px)";
  const [mobile, setMobile] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMobile(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return mobile;
}

function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

const SOURCE_PHRASES: Record<string, string> = { plaud: "Plaud", upload: "uploads", "ios-shortcut": "the iOS Shortcut" };

export function MeetingsListView({ onSelectMeeting }: { onSelectMeeting: (id: string) => void }): ReactElement {
  const [meetings, setMeetings] = useState<MeetingListItem[]>([]);
  const [activeProgressMap, setActiveProgressMap] = useState<Record<string, TranscriptionProgressUpdate>>({});
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [libraryTotal, setLibraryTotal] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [filters, setFilters] = useState<MeetingFilters>(EMPTY_FILTERS);
  const [sort, setSort] = useState<SortKey>("newest");
  const [view, setView] = useState<ViewMode>(readStoredView);
  const [availableTags, setAvailableTags] = useState<{ tag: string; meetingCount: number }[]>([]);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // `ids` = meetings to re-transcribe; `fromSelection` clears the selection once queued.
  const [bulkModal, setBulkModal] = useState<{ ids: string[]; fromSelection: boolean } | null>(null);
  const [mergingMeetings, setMergingMeetings] = useState(false);
  const [deletingSelected, setDeletingSelected] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const isMobile = useIsMobile();
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
  const meetingsRequestId = useRef(0);
  const meetingsRef = useRef<MeetingListItem[]>([]);
  const debouncedSearchRef = useRef("");
  const filtersRef = useRef<MeetingFilters>(EMPTY_FILTERS);
  const paginationRef = useRef<{ hasMore: boolean; nextOffset: number | null }>({ hasMore: false, nextOffset: null });

  useEffect(() => {
    meetingsRef.current = meetings;
  }, [meetings]);
  useEffect(() => {
    debouncedSearchRef.current = debouncedSearch;
  }, [debouncedSearch]);
  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);
  useEffect(() => {
    paginationRef.current = { hasMore, nextOffset };
  }, [hasMore, nextOffset]);

  const filtersKey = JSON.stringify(filters);
  const filtering = hasActiveFilters(filters) || debouncedSearch.trim() !== "";

  const buildMeetingsUrl = (query: string, offset: number) => {
    const params = new URLSearchParams({
      limit: String(MEETINGS_PAGE_SIZE),
      offset: String(offset),
      // Full detail: the list view needs status, audioStatus, and artifact ids.
      includeDetails: "true",
    });
    const q = query.trim();
    if (q) params.set("search", q);
    const f = filtersRef.current;
    if (f.status) params.set("status", f.status);
    if (f.source) params.set("source", f.source);
    for (const tag of f.tags) params.append("tags", tag);
    const start = dateFilterStart(f.date);
    if (start !== null) params.set("startTime", String(start));
    return `/api/meetings?${params.toString()}`;
  };

  const isUnfiltered = () => !debouncedSearchRef.current.trim() && !hasActiveFilters(filtersRef.current);

  const applyPage = (data: MeetingsResponse, mode: "reset" | "append") => {
    const incoming = data.meetings || [];
    const pagination = data.pagination;
    const totalCount = pagination ? pagination.total : incoming.length;
    if (isUnfiltered()) setLibraryTotal(totalCount);
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
    setLoadMoreError(null);
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
    setLoadMoreError(null);
    try {
      const res = await fetch(buildMeetingsUrl(debouncedSearchRef.current, offset));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as MeetingsResponse;
      if (requestId !== meetingsRequestId.current) return;
      applyPage(data, "append");
    } catch (err) {
      if (requestId !== meetingsRequestId.current) return;
      // Keep the loaded list visible; stop auto-loading until the user retries.
      setHasMore(false);
      setLoadMoreError(err instanceof Error ? err.message : "Failed to load more meetings");
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
    // The ref effect above runs first (same commit, declaration order), so
    // fetchMeetings reads the current filters.
    void fetchMeetings();
  }, [debouncedSearch, filtersKey]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/tags")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { tags?: { tag: string; meetingCount: number }[] } | null) => {
        if (!cancelled && data?.tags) setAvailableTags(data.tags);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

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
  }, [hasMore, loading, loadingMore, nextOffset, debouncedSearch, filtersKey, meetings.length]);

  const sortedMeetings = useMemo(() => sortMeetings(meetings, sort), [meetings, sort]);

  const changeView = (next: ViewMode) => {
    setView(next);
    storeView(next);
  };

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
      notify("error", err instanceof Error ? err.message : "Failed to merge meetings");
    } finally {
      setMergingMeetings(false);
    }
  };

  const removeFromList = (ids: string[]) => {
    if (ids.length === 0) return;
    const gone = new Set(ids);
    setMeetings((prev) => prev.filter((m) => !gone.has(m.id)));
    setTotal((t) => Math.max(0, t - ids.length));
    setLibraryTotal((t) => (t === null ? t : Math.max(0, t - ids.length)));
    setSelectedIds((prev) => prev.filter((sid) => !gone.has(sid)));
    if (paginationRef.current.hasMore) {
      setNextOffset(Math.max(0, meetingsRef.current.length - ids.length));
    }
    setActiveProgressMap((prev) => {
      if (!ids.some((id) => id in prev)) return prev;
      const next = { ...prev };
      for (const id of ids) delete next[id];
      return next;
    });
  };

  const deleteMeetingRequest = async (id: string) => {
    const res = await fetch(`/api/meetings/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error || `Failed to delete meeting (HTTP ${res.status})`);
    }
  };

  const handleDeleteMeeting = async (meeting: MeetingListItem) => {
    if (!(await confirmAction({ title: "Delete meeting", message: `Are you sure you want to delete meeting "${meeting.title}"? This will permanently remove its recordings, transcripts, and summaries.`, confirmLabel: "Delete", danger: true }))) {
      return;
    }
    try {
      await deleteMeetingRequest(meeting.id);
      removeFromList([meeting.id]);
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    }
  };

  // No bulk-delete endpoint: delete one by one after a single confirmation.
  const handleDeleteSelected = async () => {
    if (deletingSelected || selectedIds.length === 0) return;
    const ids = selectedIds.slice();
    const count = ids.length;
    if (
      !(await confirmAction({
        title: `Delete ${count} meeting${count === 1 ? "" : "s"}`,
        message: `Permanently delete ${count} selected meeting${count === 1 ? "" : "s"}, including recordings, transcripts and summaries? This cannot be undone.`,
        confirmLabel: `Delete ${count}`,
        danger: true
      }))
    ) {
      return;
    }
    setDeletingSelected(true);
    const deleted: string[] = [];
    const failures: string[] = [];
    for (const id of ids) {
      try {
        await deleteMeetingRequest(id);
        deleted.push(id);
      } catch (err) {
        failures.push(err instanceof Error ? err.message : String(err));
      }
    }
    removeFromList(deleted);
    setDeletingSelected(false);
    if (failures.length > 0) {
      notify("error", `Deleted ${deleted.length} of ${count}. ${failures[0]}`);
    } else {
      notify("success", `Deleted ${count} meeting${count === 1 ? "" : "s"}.`);
      setSelectMode(false);
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
            if (isUnfiltered()) setLibraryTotal(freshTotal);
            const more = combined.length < freshTotal;
            setHasMore(more);
            setNextOffset(more ? combined.length : null);
          }
        }
      } catch {}
    }, 2500);

    return () => clearInterval(interval);
  }, [meetings, activeProgressMap, debouncedSearch, filtersKey]);

  const closeMore = useCallback(() => setMoreOpen(false), []);

  const clearAllFilters = () => {
    setFilters(EMPTY_FILTERS);
    setSearch("");
  };

  const sources = Array.from(new Set(meetings.map((m) => m.source)));
  const sourcePhrase = sources.length > 0 ? ` from ${joinWords(sources.map((s) => SOURCE_PHRASES[s] ?? sourceLabel(s)))}` : "";
  const shownTotal = libraryTotal ?? total;
  const subtitle = loading && libraryTotal === null
    ? "Loading your recordings…"
    : `${shownTotal} recording${shownTotal === 1 ? "" : "s"}${filtering ? "" : sourcePhrase}.`;

  const selectionActive = selectMode || selectedIds.length > 0;
  const viewProps = {
    meetings: sortedMeetings,
    progressMap: activeProgressMap,
    selectedIds,
    selectMode,
    onOpen: onSelectMeeting,
    onToggle: toggleSelectMeeting,
    onRetranscribe: (id: string) => setBulkModal({ ids: [id], fromSelection: false }),
    onDelete: (m: MeetingListItem) => void handleDeleteMeeting(m),
  };

  const moreMenu = (
    <>
      <button
        ref={moreButtonRef}
        type="button"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={moreOpen}
        onClick={() => setMoreOpen((v) => !v)}
        className="inline-flex h-11 w-11 items-center justify-center rounded-md text-base-content/60 hover:bg-hover hover:text-base-content sm:h-8 sm:w-8"
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
      </button>
      {moreOpen && (
        <Popover anchor={moreButtonRef.current} onClose={closeMore} align="end" width={240} label="More actions">
          <MenuItem
            icon={<CheckSquare className="h-4 w-4" />}
            onSelect={() => {
              setMoreOpen(false);
              if (selectMode) exitSelectMode();
              else setSelectMode(true);
            }}
          >
            {selectMode ? "Done selecting" : "Select meetings"}
          </MenuItem>
          <MenuItem
            icon={<RotateCw className="h-4 w-4" />}
            onSelect={() => {
              setMoreOpen(false);
              setBulkModal({ ids: selectedIds, fromSelection: selectedIds.length > 0 });
            }}
          >
            Bulk re-transcribe…
          </MenuItem>
        </Popover>
      )}
    </>
  );

  const searchBox = (
    <label className="flex h-11 min-w-0 items-center gap-1.5 rounded-md bg-hover px-2.5 text-base-content/60 focus-within:ring-1 focus-within:ring-primary/40 sm:h-8 sm:w-56">
      <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
      <input
        type="search"
        placeholder="Search title, tags, transcript"
        aria-label="Search meetings"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full min-w-0 bg-transparent text-sm text-base-content outline-none placeholder:text-base-content/50"
      />
    </label>
  );

  const resultsLabel = !loading && !error && (
    <span className="shrink-0 whitespace-nowrap text-[13px] text-base-content/60" aria-live="polite">
      {total} result{total === 1 ? "" : "s"}
      {sort !== "newest" && hasMore ? " · sorted within loaded" : ""}
    </span>
  );

  const retryLoadMore = () => {
    paginationRef.current = { ...paginationRef.current, hasMore: true };
    setHasMore(true);
    setLoadMoreError(null);
    void loadMore();
  };

  return (
    <div className={`flex flex-col gap-5 ${selectionActive ? "pb-24" : ""}`}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 space-y-1.5">
          <h1 className="text-[30px] font-bold leading-tight tracking-tight sm:text-4xl">Meetings</h1>
          <p className="text-base-content/60">{subtitle}</p>
        </div>
        {isMobile && (
          <div className="flex shrink-0 items-center gap-1">
            {moreMenu}
            <button
              type="button"
              onClick={() => setShowUploadModal(true)}
              aria-label="Upload audio"
              className="btn btn-primary btn-square min-h-11 min-w-11"
            >
              <Plus className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

      {isMobile ? (
        <div className="-mx-4 flex flex-col gap-3">
          <div className="px-4">{searchBox}</div>
          <div className="flex items-center gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <FilterChips filters={filters} onChange={setFilters} availableTags={availableTags} />
            <SortMenu sort={sort} onChange={setSort} variant="chip" />
            {(hasActiveFilters(filters) || search) && <ClearFiltersButton onClick={clearAllFilters} />}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-2 border-b border-divider">
            <div role="tablist" aria-label="View" className="flex gap-1">
              {(
                [
                  { key: "table", label: "Table", icon: <Table2 className="h-4 w-4" aria-hidden="true" /> },
                  { key: "gallery", label: "Gallery", icon: <LayoutGrid className="h-4 w-4" aria-hidden="true" /> },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  role="tab"
                  aria-selected={view === tab.key}
                  onClick={() => changeView(tab.key)}
                  className={`-mb-px flex h-10 items-center gap-1.5 rounded-t-md border-b-2 px-2.5 text-sm hover:bg-hover ${
                    view === tab.key ? "border-base-content font-semibold" : "border-transparent text-base-content/70"
                  }`}
                >
                  {tab.icon}
                  {tab.label}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-1 pb-1.5">
              <SortMenu sort={sort} onChange={setSort} />
              {searchBox}
              {moreMenu}
              <button
                type="button"
                onClick={() => setShowUploadModal(true)}
                className="btn btn-primary btn-sm ml-1 h-8 gap-1.5 font-medium"
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                Upload audio
              </button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <FilterChips filters={filters} onChange={setFilters} availableTags={availableTags} />
            {(hasActiveFilters(filters) || search) && <ClearFiltersButton onClick={clearAllFilters} />}
            <span className="ml-1">{resultsLabel}</span>
          </div>
        </div>
      )}

      {loading && <MeetingsSkeleton />}

      {!loading && error && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-error/40 bg-error/10 px-4 py-3 text-sm text-error">
          <span className="min-w-0 flex-1">Couldn’t load meetings: {error}</span>
          <button type="button" onClick={() => void fetchMeetings()} className="btn btn-sm btn-ghost min-h-11 text-error sm:min-h-8">
            Try again
          </button>
        </div>
      )}

      {!loading && !error && meetings.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-base-content/15 px-6 py-16 text-center">
          {filtering ? (
            <>
              <p className="font-medium">No meetings match</p>
              <p className="max-w-sm text-sm text-base-content/60">Try a different search or remove some filters.</p>
              <button type="button" onClick={clearAllFilters} className="btn btn-sm min-h-11 sm:min-h-8">
                Clear search and filters
              </button>
            </>
          ) : (
            <>
              <p className="font-medium">No meetings yet</p>
              <p className="max-w-sm text-sm text-base-content/60">
                Upload a recording, or connect Plaud or the iOS Shortcut in Settings, and it will show up here.
              </p>
              <button type="button" onClick={() => setShowUploadModal(true)} className="btn btn-primary btn-sm min-h-11 gap-1.5 sm:min-h-8">
                <Plus className="h-4 w-4" aria-hidden="true" />
                Upload audio
              </button>
            </>
          )}
        </div>
      )}

      {!loading && !error && meetings.length > 0 && (
        <>
          {isMobile ? (
            <MeetingMobileList {...viewProps} grouped={sort === "newest" || sort === "oldest"} />
          ) : view === "gallery" ? (
            <MeetingGallery {...viewProps} />
          ) : (
            <MeetingTable {...viewProps} onToggleAll={(select) => setSelectedIds(select ? sortedMeetings.map((m) => m.id) : [])} />
          )}

          <div className="flex flex-col items-start gap-2">
            <p className="text-xs text-base-content/50">
              Showing {meetings.length} of {total} meeting{total === 1 ? "" : "s"}
            </p>
            {hasMore && !loadingMore && (
              <button
                type="button"
                onClick={() => void loadMore()}
                className="inline-flex h-11 items-center rounded-md px-2 text-sm text-base-content/60 hover:bg-hover hover:text-base-content sm:h-8"
              >
                Load {Math.min(MEETINGS_PAGE_SIZE, Math.max(0, total - meetings.length))} more
              </button>
            )}
            {loadingMore && <p className="text-xs text-base-content/50">Loading more meetings…</p>}
            {loadMoreError && (
              <p role="alert" className="flex items-center gap-2 text-xs text-error">
                Couldn’t load more: {loadMoreError}
                <button type="button" onClick={retryLoadMore} className="underline">
                  Retry
                </button>
              </p>
            )}
            <div ref={loadMoreSentinelRef} aria-hidden="true" className="h-1 w-full" />
          </div>
        </>
      )}

      {selectionActive && (
        <div
          role="toolbar"
          aria-label="Bulk actions"
          className="fixed bottom-[calc(5.5rem+env(safe-area-inset-bottom))] left-1/2 z-40 flex max-w-[calc(100vw-16px)] -translate-x-1/2 items-center gap-0.5 rounded-lg bg-base-100 p-1.5 shadow-pop lg:bottom-8 lg:left-[calc(50%+7.5rem)]"
        >
          <span className="whitespace-nowrap px-2 text-sm font-medium text-primary sm:px-2.5">
            {selectedIds.length > 0 ? `${selectedIds.length} selected` : "Select meetings"}
          </span>
          <span className="mx-0.5 h-5 w-px bg-base-content/10" aria-hidden="true" />
          {selectedIds.length < meetings.length && (
            <BulkButton label={`Select all ${meetings.length}`} shortLabel="All" onClick={handleSelectVisible} />
          )}
          <BulkButton
            label="Re-transcribe…"
            icon={<RotateCw className="h-4 w-4" aria-hidden="true" />}
            disabled={selectedIds.length === 0}
            onClick={() => setBulkModal({ ids: selectedIds, fromSelection: true })}
          />
          <BulkButton
            label={mergingMeetings ? "Merging…" : "Merge…"}
            icon={<Link2 className="h-4 w-4" aria-hidden="true" />}
            disabled={selectedIds.length < 2 || mergingMeetings}
            title="Join the selected meetings (chronological) into one and delete the rest"
            onClick={() => void handleMergeSelected()}
          />
          <BulkButton
            label={deletingSelected ? "Deleting…" : "Delete…"}
            icon={<Trash2 className="h-4 w-4" aria-hidden="true" />}
            danger
            disabled={selectedIds.length === 0 || deletingSelected}
            onClick={() => void handleDeleteSelected()}
          />
          <button
            type="button"
            aria-label="Clear selection"
            onClick={exitSelectMode}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-base-content/60 hover:bg-hover hover:text-base-content sm:h-[34px] sm:w-[34px]"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}

      {bulkModal && (
        <BulkTranscribeModal
          selectedIds={bulkModal.ids}
          listSearch={search}
          listFilters={{ tags: filters.tags, status: filters.status }}
          onClose={() => setBulkModal(null)}
          onQueued={(summary, queuedIds) => {
            const fromSelection = bulkModal.fromSelection;
            setBulkModal(null);
            notify("success", summary);
            if (fromSelection && queuedIds.length > 0) {
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

function BulkButton({
  label,
  shortLabel,
  icon,
  danger = false,
  disabled = false,
  title,
  onClick,
}: {
  label: string;
  shortLabel?: string;
  icon?: ReactElement;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
      aria-label={label}
      className={`inline-flex h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-sm hover:bg-hover disabled:pointer-events-none disabled:opacity-40 sm:h-[34px] sm:px-2.5 ${
        danger ? "text-error" : ""
      }`}
    >
      {icon}
      {shortLabel ? (
        <>
          <span className="sm:hidden">{shortLabel}</span>
          <span className="hidden sm:inline">{label}</span>
        </>
      ) : (
        <span className={icon ? "hidden sm:inline" : ""}>{label}</span>
      )}
    </button>
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
  listFilters,
  onClose,
  onQueued
}: {
  selectedIds: string[];
  listSearch: string;
  /** Tag/status filters active on the list; applied to the "matching" scope. */
  listFilters?: { tags: string[]; status: string };
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
  const [useListFilters, setUseListFilters] = useState(true);
  const listTags = listFilters?.tags ?? [];
  const listStatus = listFilters?.status ?? "";
  const hasListFilters = listTags.length > 0 || Boolean(listStatus);
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
        if (useListFilters) {
          if (listTags.length > 0) filters.tags = listTags;
          if (listStatus) filters.status = listStatus;
        }
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
    <Modal onClose={onClose} title={selectedIds.length === 1 ? "Re-transcribe" : "Bulk re-transcribe"} ariaLabel="Re-transcribe meetings" maxWidth="max-w-lg">
      {error && <div className="rounded-lg border border-error/40 bg-error/10 p-3 text-xs text-error">{error}</div>}

      {result ? (
        <div className="space-y-4 text-sm">
          <div className="rounded-lg border border-primary/40 bg-primary/10 p-4 text-primary">
            Queued {result.queued} of {result.total} meeting{result.total === 1 ? "" : "s"} with <strong>{result.provider}</strong>
            {result.alreadyRunning > 0 && <span> ({result.alreadyRunning} already running)</span>}
            {result.skipped > 0 && <span> ({result.skipped} skipped)</span>}. Watch progress on the meetings list.
          </div>
          {failures.length > 0 && (
            <ul className="space-y-1 text-xs text-base-content/70">
              {failures.map((f) => (
                <li key={f.meetingId} className="rounded-md border border-base-content/15 px-3 py-2">
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
            <span className="text-sm font-medium">Which meetings?</span>
            <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-base-content/15 px-3 py-2.5 hover:bg-hover">
              <input type="radio" name="bulk-scope" checked={scope === "selected"} onChange={() => setScope("selected")} disabled={selectedIds.length === 0} className="accent-primary" />
              <span>Selected meetings ({selectedIds.length}){selectedIds.length === 0 && ": tick meetings in the list first"}</span>
            </label>
            <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-base-content/15 px-3 py-2.5 hover:bg-hover">
              <input type="radio" name="bulk-scope" checked={scope === "filtered"} onChange={() => setScope("filtered")} className="accent-primary" />
              <span>All meetings matching filters (whole library, server-side)</span>
            </label>
          </div>

          {scope === "filtered" && (
            <div className="space-y-3 rounded-lg border border-base-content/15 p-4">
              {hasListFilters && (
                <label className="flex cursor-pointer items-start gap-2 text-xs text-base-content">
                  <input type="checkbox" checked={useListFilters} onChange={(e) => setUseListFilters(e.target.checked)} className="checkbox checkbox-sm mt-0.5" />
                  <span>
                    Also apply the list filters
                    {listStatus && <> · status <strong>{listStatus}</strong></>}
                    {listTags.length > 0 && <> · tags <strong>{listTags.join(", ")}</strong></>}
                  </span>
                </label>
              )}
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
            <span className="text-sm font-medium text-base-content">Transcribe with</span>
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
            <span className="text-sm font-medium text-base-content">Language</span>
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
            <button type="button" onClick={onClose} className="btn btn-ghost min-h-11">Cancel</button>
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
