import { useCallback, useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { ArrowUpDown, ChevronDown, X } from "lucide-react";
import type { MeetingListItem } from "../../api/types.ts";
import { MenuDivider, MenuItem, Popover } from "./Popover";
import { SOURCE_LABELS, tagClass, tagColor } from "./format";

export type StatusFilter = "" | MeetingListItem["status"];
export type SourceFilter = "" | MeetingListItem["source"];
export type DatePreset = "" | "today" | "7d" | "30d" | "365d";
export type SortKey = "newest" | "oldest" | "title" | "longest";

export interface MeetingFilters {
  status: StatusFilter;
  source: SourceFilter;
  tags: string[];
  date: DatePreset;
}

export const EMPTY_FILTERS: MeetingFilters = { status: "", source: "", tags: [], date: "" };

export function hasActiveFilters(f: MeetingFilters): boolean {
  return Boolean(f.status || f.source || f.date || f.tags.length > 0);
}

const STATUS_OPTIONS: { value: Exclude<StatusFilter, "">; label: string }[] = [
  { value: "ready", label: "Ready" },
  { value: "processing", label: "Processing" },
  { value: "pending", label: "Not transcribed" },
  { value: "error", label: "Failed" },
  { value: "duplicate", label: "Duplicate" },
];

const DATE_OPTIONS: { value: Exclude<DatePreset, "">; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "365d", label: "Last 12 months" },
];

export const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "title", label: "Title A–Z" },
  { value: "longest", label: "Longest first" },
];

/** Lower bound (epoch ms) for a date preset, evaluated at request time. */
export function dateFilterStart(preset: DatePreset): number | null {
  if (!preset) return null;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 24 * 60 * 60 * 1000;
  switch (preset) {
    case "today":
      return startOfToday;
    case "7d":
      return startOfToday - 6 * day;
    case "30d":
      return startOfToday - 29 * day;
    case "365d":
      return startOfToday - 364 * day;
  }
}

export function sortMeetings(meetings: MeetingListItem[], sort: SortKey): MeetingListItem[] {
  const list = meetings.slice();
  switch (sort) {
    case "oldest":
      return list.sort((a, b) => a.startTime - b.startTime);
    case "title":
      return list.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true }));
    case "longest":
      return list.sort((a, b) => b.endTime - b.startTime - (a.endTime - a.startTime));
    default:
      return list.sort((a, b) => b.startTime - a.startTime);
  }
}

const chipBase =
  "inline-flex h-11 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-[13px] transition-colors sm:h-7 sm:px-2.5";

function ChipMenu({
  label,
  active,
  icon,
  width = 224,
  menuLabel,
  children,
}: {
  label: ReactNode;
  active: boolean;
  icon?: ReactNode;
  width?: number;
  menuLabel: string;
  children: (close: () => void) => ReactNode;
}): ReactElement {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`${chipBase} ${
          active
            ? "border-primary bg-primary/10 font-medium text-primary"
            : "border-base-content/15 text-base-content/70 hover:bg-hover hover:text-base-content"
        }`}
      >
        {icon}
        {label}
        <ChevronDown className="h-3.5 w-3.5 opacity-60" aria-hidden="true" />
      </button>
      {open && (
        <Popover anchor={ref.current} onClose={close} width={width} label={menuLabel}>
          {children(close)}
        </Popover>
      )}
    </>
  );
}

export function FilterChips({
  filters,
  onChange,
  availableTags,
}: {
  filters: MeetingFilters;
  onChange: (next: MeetingFilters) => void;
  availableTags: { tag: string; meetingCount: number }[];
}): ReactElement {
  const [tagQuery, setTagQuery] = useState("");
  const statusLabel = STATUS_OPTIONS.find((o) => o.value === filters.status)?.label;
  const dateLabel = DATE_OPTIONS.find((o) => o.value === filters.date)?.label;
  const tagsLabel =
    filters.tags.length === 0 ? "Tags" : filters.tags.length <= 2 ? `Tags: ${filters.tags.join(", ")}` : `Tags: ${filters.tags.length}`;

  const visibleTags = useMemo(() => {
    const q = tagQuery.trim().toLowerCase();
    const selectedLower = new Set(filters.tags.map((t) => t.toLowerCase()));
    // Keep selected tags listed even if the tag index no longer returns them.
    const extra = filters.tags
      .filter((t) => !availableTags.some((a) => a.tag.toLowerCase() === t.toLowerCase()))
      .map((tag) => ({ tag, meetingCount: 0 }));
    return [...extra, ...availableTags]
      .filter((t) => !q || t.tag.toLowerCase().includes(q) || selectedLower.has(t.tag.toLowerCase()));
  }, [availableTags, filters.tags, tagQuery]);

  const toggleTag = (tag: string) => {
    const lower = tag.toLowerCase();
    const exists = filters.tags.some((t) => t.toLowerCase() === lower);
    onChange({ ...filters, tags: exists ? filters.tags.filter((t) => t.toLowerCase() !== lower) : [...filters.tags, tag] });
  };

  return (
    <>
      <ChipMenu label={statusLabel ? `Status: ${statusLabel}` : "Status"} active={Boolean(filters.status)} menuLabel="Filter by status">
        {(close) => (
          <>
            <MenuItem checked={!filters.status} onSelect={() => { onChange({ ...filters, status: "" }); close(); }}>
              Any status
            </MenuItem>
            <MenuDivider />
            {STATUS_OPTIONS.map((o) => (
              <MenuItem key={o.value} checked={filters.status === o.value} onSelect={() => { onChange({ ...filters, status: o.value }); close(); }}>
                {o.label}
              </MenuItem>
            ))}
          </>
        )}
      </ChipMenu>

      <ChipMenu
        label={filters.source ? `Source: ${SOURCE_LABELS[filters.source]}` : "Source"}
        active={Boolean(filters.source)}
        menuLabel="Filter by source"
      >
        {(close) => (
          <>
            <MenuItem checked={!filters.source} onSelect={() => { onChange({ ...filters, source: "" }); close(); }}>
              Any source
            </MenuItem>
            <MenuDivider />
            {(Object.keys(SOURCE_LABELS) as Exclude<SourceFilter, "">[]).map((value) => (
              <MenuItem key={value} checked={filters.source === value} onSelect={() => { onChange({ ...filters, source: value }); close(); }}>
                {SOURCE_LABELS[value]}
              </MenuItem>
            ))}
          </>
        )}
      </ChipMenu>

      <ChipMenu label={tagsLabel} active={filters.tags.length > 0} width={260} menuLabel="Filter by tags">
        {() => (
          <>
            {availableTags.length > 8 && (
              <div className="p-1">
                <input
                  type="search"
                  value={tagQuery}
                  onChange={(e) => setTagQuery(e.target.value)}
                  placeholder="Find a tag…"
                  aria-label="Find a tag"
                  className="input input-sm w-full"
                />
              </div>
            )}
            {visibleTags.length === 0 ? (
              <p className="px-2 py-2 text-base-content/60">{availableTags.length === 0 ? "No tags yet." : "No matching tags."}</p>
            ) : (
              visibleTags.map((t) => {
                const checked = filters.tags.some((s) => s.toLowerCase() === t.tag.toLowerCase());
                return (
                  <MenuItem key={t.tag} checked={checked} onSelect={() => toggleTag(t.tag)}>
                    <span className="flex items-center gap-2">
                      <span className={tagClass(tagColor(t.tag))}>{t.tag}</span>
                      {t.meetingCount > 0 && <span className="text-xs text-base-content/50">{t.meetingCount}</span>}
                    </span>
                  </MenuItem>
                );
              })
            )}
            {filters.tags.length > 0 && (
              <>
                <MenuDivider />
                <p className="px-2 pb-1 text-xs text-base-content/50">Meetings must have all selected tags.</p>
                <MenuItem onSelect={() => onChange({ ...filters, tags: [] })}>Clear tags</MenuItem>
              </>
            )}
          </>
        )}
      </ChipMenu>

      <ChipMenu label={dateLabel ? `Date: ${dateLabel}` : "Date"} active={Boolean(filters.date)} menuLabel="Filter by date">
        {(close) => (
          <>
            <MenuItem checked={!filters.date} onSelect={() => { onChange({ ...filters, date: "" }); close(); }}>
              Any time
            </MenuItem>
            <MenuDivider />
            {DATE_OPTIONS.map((o) => (
              <MenuItem key={o.value} checked={filters.date === o.value} onSelect={() => { onChange({ ...filters, date: o.value }); close(); }}>
                {o.label}
              </MenuItem>
            ))}
          </>
        )}
      </ChipMenu>
    </>
  );
}

export function SortMenu({ sort, onChange, variant = "button" }: { sort: SortKey; onChange: (s: SortKey) => void; variant?: "button" | "chip" }): ReactElement {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const label = SORT_OPTIONS.find((o) => o.value === sort)?.label ?? "Newest first";
  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Sort: ${label}`}
        onClick={() => setOpen((v) => !v)}
        className={
          variant === "chip"
            ? `${chipBase} border-base-content/15 text-base-content/70 hover:bg-hover`
            : "inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm text-base-content/60 hover:bg-hover hover:text-base-content"
        }
      >
        <ArrowUpDown className="h-3.5 w-3.5" aria-hidden="true" />
        {label}
      </button>
      {open && (
        <Popover anchor={ref.current} onClose={close} width={200} label="Sort meetings">
          {SORT_OPTIONS.map((o) => (
            <MenuItem key={o.value} checked={sort === o.value} onSelect={() => { onChange(o.value); close(); }}>
              {o.label}
            </MenuItem>
          ))}
        </Popover>
      )}
    </>
  );
}

export function ClearFiltersButton({ onClick }: { onClick: () => void }): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-11 shrink-0 items-center gap-1 rounded-md px-2 text-[13px] text-base-content/60 hover:bg-hover hover:text-base-content sm:h-7"
    >
      <X className="h-3.5 w-3.5" aria-hidden="true" />
      Clear
    </button>
  );
}
