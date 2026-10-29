import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactElement, ReactNode } from "react";
import { ArrowRight, AudioLines, Search } from "lucide-react";
import type { MeetingListItem } from "../api/types.ts";
import type { MeetingsResponse } from "../lib/common";
import { formatDate } from "../lib/common";

export interface PaletteAction {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

interface PaletteItem {
  key: string;
  group: string;
  label: ReactNode;
  meta?: string;
  icon: ReactElement;
  run: () => void;
}

/* ⌘K / Ctrl+K palette: searches meetings (title, tags, transcript) and
   lists app actions. Arrow keys move, Enter runs, Esc closes. */
export function CommandPalette({
  open,
  onClose,
  onSelectMeeting,
  actions,
}: {
  open: boolean;
  onClose: () => void;
  onSelectMeeting: (id: string) => void;
  actions: PaletteAction[];
}): ReactElement | null {
  const [query, setQuery] = useState("");
  const [meetings, setMeetings] = useState<MeetingListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setCursor(0);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ limit: "6", offset: "0" });
        if (q) params.set("search", q);
        const res = await fetch(`/api/meetings?${params.toString()}`, { signal: controller.signal });
        if (res.ok) {
          const data = (await res.json()) as MeetingsResponse;
          setMeetings(data.meetings);
        }
      } catch {
        // aborted or offline: keep the previous results
      } finally {
        setLoading(false);
      }
    }, 150);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [open, query]);

  const items = useMemo<PaletteItem[]>(() => {
    const q = query.trim().toLowerCase();
    const meetingItems: PaletteItem[] = meetings.map((m) => ({
      key: `m:${m.id}`,
      group: q ? "Meetings" : "Recent meetings",
      label: m.title,
      meta: formatDate(m.startTime),
      icon: <AudioLines className="h-4 w-4" aria-hidden="true" />,
      run: () => onSelectMeeting(m.id),
    }));
    const actionItems: PaletteItem[] = actions
      .filter((a) => !q || a.label.toLowerCase().includes(q))
      .map((a) => ({
        key: `a:${a.id}`,
        group: "Actions",
        label: a.label,
        meta: a.hint,
        icon: <ArrowRight className="h-4 w-4" aria-hidden="true" />,
        run: a.run,
      }));
    return [...meetingItems, ...actionItems];
  }, [meetings, actions, query, onSelectMeeting]);

  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(items.length - 1, 0)));
  }, [items.length]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  if (!open) return null;

  const runItem = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => (items.length ? (c + 1) % items.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => (items.length ? (c - 1 + items.length) % items.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      runItem(items[cursor]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  let lastGroup = "";
  return (
    <div className="fixed inset-0 z-[90] flex items-start justify-center bg-black/45 px-4 pt-[12vh]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search Olive"
        className="w-full max-w-xl overflow-hidden rounded-xl bg-base-100 shadow-pop"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <label className="flex h-14 items-center gap-3 border-b border-divider px-4">
          <Search className="h-5 w-5 text-base-content/50" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search meetings or jump to…"
            aria-label="Search meetings or actions"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-list"
            aria-activedescendant={items[cursor] ? `cp-${cursor}` : undefined}
            className="w-full bg-transparent text-base outline-none placeholder:text-base-content/40"
          />
          {loading && <span className="loading loading-spinner loading-xs text-base-content/40" aria-hidden="true" />}
        </label>
        <div ref={listRef} id="command-palette-list" role="listbox" className="max-h-[50vh] overflow-y-auto p-1.5">
          {items.length === 0 && !loading && <p className="px-3 py-6 text-center text-sm text-base-content/60">No results</p>}
          {items.map((item, index) => {
            const header = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return (
              <div key={item.key}>
                {header && <div className="px-3 pt-2.5 pb-1 text-xs font-medium text-base-content/55">{header}</div>}
                <div
                  id={`cp-${index}`}
                  data-index={index}
                  role="option"
                  aria-selected={index === cursor}
                  onMouseMove={() => setCursor(index)}
                  onClick={() => runItem(item)}
                  className={`flex h-10 cursor-pointer items-center gap-3 rounded-md px-3 text-sm ${index === cursor ? "bg-active" : ""}`}
                >
                  <span className="text-base-content/50">{item.icon}</span>
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.meta && <span className="shrink-0 text-xs text-base-content/55">{item.meta}</span>}
                </div>
              </div>
            );
          })}
        </div>
        <footer className="hidden gap-4 border-t border-divider px-4 py-2 text-xs text-base-content/55 sm:flex">
          <span>↑↓ Navigate</span>
          <span>↵ Open</span>
          <span className="ml-auto">Esc Close</span>
        </footer>
      </div>
    </div>
  );
}
