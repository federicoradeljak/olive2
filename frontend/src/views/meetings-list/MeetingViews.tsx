import { useCallback, useRef, useState } from "react";
import type { ReactElement } from "react";
import { AudioLines, ExternalLink, MoreHorizontal, RotateCw, Trash2 } from "lucide-react";
import type { MeetingListItem, TranscriptionProgressUpdate } from "../../api/types.ts";
import { formatDate } from "../../lib/common";
import { MenuDivider, MenuItem, Popover } from "./Popover";
import { dateGroup, formatLength, formatShortDate, humanStatus, sourceLabel, tagClass, tagColor } from "./format";
import type { DateGroup } from "./format";

export interface MeetingViewProps {
  meetings: MeetingListItem[];
  progressMap: Record<string, TranscriptionProgressUpdate>;
  selectedIds: string[];
  selectMode: boolean;
  onOpen: (id: string) => void;
  onToggle: (id: string) => void;
  onRetranscribe: (id: string) => void;
  onDelete: (meeting: MeetingListItem) => void;
}

function isAudioPending(meeting: MeetingListItem): boolean {
  return meeting.audioStatus === "retrieving" || meeting.audioStatus === "missing";
}

export function StatusPill({
  meeting,
  progress,
  onRetry,
  showBar = false,
}: {
  meeting: MeetingListItem;
  progress: TranscriptionProgressUpdate | undefined;
  onRetry?: () => void;
  showBar?: boolean;
}): ReactElement {
  const status = humanStatus(meeting, progress);
  const pillClass = `${tagClass(status.color)} tag-dot w-fit`;
  const pill =
    status.retry && onRetry ? (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRetry();
        }}
        title={status.detail ? `${status.detail}\nClick to re-transcribe` : "Click to re-transcribe"}
        className={`${pillClass} cursor-pointer hover:underline`}
      >
        {status.label}
      </button>
    ) : (
      <span className={`${pillClass} ${meeting.audioStatus === "retrieving" && !progress ? "animate-pulse" : ""}`} title={status.detail}>
        {status.label}
      </span>
    );
  return (
    <span className="inline-flex flex-col gap-1">
      {pill}
      {showBar && status.percent !== null && (
        <span
          role="progressbar"
          aria-label={`${meeting.title} progress`}
          aria-valuenow={status.percent}
          aria-valuemin={0}
          aria-valuemax={100}
          className="block h-[3px] w-36 max-w-full overflow-hidden rounded-full bg-active"
        >
          <span className="block h-full bg-info transition-[width] duration-500" style={{ width: `${Math.max(4, status.percent)}%` }} />
        </span>
      )}
    </span>
  );
}

export function TagList({ tags, max }: { tags: string[]; max?: number }): ReactElement | null {
  if (tags.length === 0) return null;
  const shown = max ? tags.slice(0, max) : tags;
  const rest = tags.length - shown.length;
  return (
    <span className="flex flex-wrap gap-1">
      {shown.map((tag) => (
        <span key={tag} className={tagClass(tagColor(tag))}>
          {tag}
        </span>
      ))}
      {rest > 0 && <span className="tag" title={tags.slice(shown.length).join(", ")}>+{rest}</span>}
    </span>
  );
}

function SummaryBadge(): ReactElement {
  return (
    <span className="shrink-0 rounded border border-base-content/15 px-1.5 text-xs font-normal text-base-content/60">Summary</span>
  );
}

function RowMenu({
  meeting,
  onOpen,
  onRetranscribe,
  onDelete,
  className = "",
}: {
  meeting: MeetingListItem;
  onOpen: () => void;
  onRetranscribe: () => void;
  onDelete: () => void;
  className?: string;
}): ReactElement {
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label={`More actions for ${meeting.title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={`inline-flex h-11 w-11 items-center justify-center rounded-md text-base-content/60 hover:bg-hover hover:text-base-content sm:h-8 sm:w-8 ${className}`}
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
      </button>
      {open && (
        <Popover anchor={btnRef.current} onClose={close} align="end" width={200} label={`Actions for ${meeting.title}`}>
          <div onClick={(e) => e.stopPropagation()}>
            <MenuItem icon={<ExternalLink className="h-4 w-4" />} onSelect={run(onOpen)}>
              Open
            </MenuItem>
            <MenuItem icon={<RotateCw className="h-4 w-4" />} onSelect={run(onRetranscribe)}>
              Re-transcribe…
            </MenuItem>
            <MenuDivider />
            <MenuItem icon={<Trash2 className="h-4 w-4" />} danger onSelect={run(onDelete)}>
              Delete…
            </MenuItem>
          </div>
        </Popover>
      )}
    </>
  );
}

function SelectBox({ meeting, checked, onToggle, className = "" }: { meeting: MeetingListItem; checked: boolean; onToggle: () => void; className?: string }): ReactElement {
  return (
    <label className={`flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center sm:h-8 sm:w-8 ${className}`} onClick={(e) => e.stopPropagation()}>
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="checkbox checkbox-sm checkbox-primary"
        aria-label={`Select ${meeting.title}`}
      />
    </label>
  );
}

/* ------------------------------------------------------------------ */
/* Table                                                               */
/* ------------------------------------------------------------------ */

export function MeetingTable({
  meetings,
  progressMap,
  selectedIds,
  selectMode,
  onOpen,
  onToggle,
  onToggleAll,
  onRetranscribe,
  onDelete,
}: MeetingViewProps & { onToggleAll: (select: boolean) => void }): ReactElement {
  const selectedCount = meetings.filter((m) => selectedIds.includes(m.id)).length;
  const allSelected = meetings.length > 0 && selectedCount === meetings.length;
  return (
    <div className="-mx-2 overflow-x-auto px-2">
      <table className="w-full min-w-[640px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-divider text-left text-base-content/60">
            <th className="w-10 px-1 py-1.5 font-normal">
              <label className="flex h-8 w-8 cursor-pointer items-center justify-center">
                <input
                  type="checkbox"
                  className="checkbox checkbox-sm checkbox-primary"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = selectedCount > 0 && !allSelected;
                  }}
                  onChange={() => onToggleAll(!allSelected)}
                  aria-label={allSelected ? "Clear selection" : `Select all ${meetings.length} loaded meetings`}
                />
              </label>
            </th>
            <th className="px-2 py-1.5 font-normal">Title</th>
            <th className="w-36 px-2 py-1.5 font-normal">Date</th>
            <th className="hidden w-24 px-2 py-1.5 font-normal md:table-cell">Length</th>
            <th className="hidden w-44 px-2 py-1.5 font-normal lg:table-cell">Tags</th>
            <th className="w-48 px-2 py-1.5 font-normal">Status</th>
            <th className="w-10 px-1 py-1.5 font-normal">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {meetings.map((meeting) => {
            const selected = selectedIds.includes(meeting.id);
            const progress = progressMap[meeting.id];
            return (
              <tr
                key={meeting.id}
                onClick={() => (selectMode ? onToggle(meeting.id) : onOpen(meeting.id))}
                aria-selected={selected}
                className={`group cursor-pointer border-b border-divider ${selected ? "bg-primary/10" : "hover:bg-hover"} ${
                  isAudioPending(meeting) && !progress ? "text-base-content/60" : ""
                }`}
              >
                <td className="px-1 py-1">
                  <SelectBox
                    meeting={meeting}
                    checked={selected}
                    onToggle={() => onToggle(meeting.id)}
                    className={selected || selectMode || selectedIds.length > 0 ? "" : "opacity-40 group-hover:opacity-100 focus-within:opacity-100"}
                  />
                </td>
                <td className="px-2 py-2">
                  <span className="flex min-w-0 items-center gap-2 font-medium">
                    <AudioLines className="h-4 w-4 shrink-0 text-base-content/50" aria-hidden="true" />
                    <a
                      href={`/meetings/${meeting.id}`}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (selectMode) onToggle(meeting.id);
                        else onOpen(meeting.id);
                      }}
                      className="min-w-0 truncate hover:underline"
                    >
                      {meeting.title}
                    </a>
                    {meeting.primarySummaryArtifactId && <SummaryBadge />}
                  </span>
                </td>
                <td className="whitespace-nowrap px-2 py-2 text-base-content/60" title={formatDate(meeting.startTime)}>
                  {formatShortDate(meeting.startTime)}
                </td>
                <td className="hidden px-2 py-2 font-mono text-[13px] text-base-content/60 md:table-cell">
                  {formatLength(meeting.endTime - meeting.startTime)}
                </td>
                <td className="hidden px-2 py-2 lg:table-cell">
                  <TagList tags={meeting.tags} max={3} />
                </td>
                <td className="px-2 py-2">
                  <StatusPill meeting={meeting} progress={progress} showBar onRetry={() => onRetranscribe(meeting.id)} />
                </td>
                <td className="px-1 py-1 text-right">
                  <RowMenu
                    meeting={meeting}
                    onOpen={() => onOpen(meeting.id)}
                    onRetranscribe={() => onRetranscribe(meeting.id)}
                    onDelete={() => onDelete(meeting)}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Gallery                                                             */
/* ------------------------------------------------------------------ */

export function MeetingGallery({ meetings, progressMap, selectedIds, selectMode, onOpen, onToggle, onRetranscribe, onDelete }: MeetingViewProps): ReactElement {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3.5">
      {meetings.map((meeting) => {
        const selected = selectedIds.includes(meeting.id);
        const progress = progressMap[meeting.id];
        const percent = humanStatus(meeting, progress).percent;
        return (
          <div
            key={meeting.id}
            onClick={() => (selectMode ? onToggle(meeting.id) : onOpen(meeting.id))}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
              e.preventDefault();
              if (selectMode) onToggle(meeting.id);
              else onOpen(meeting.id);
            }}
            role="link"
            tabIndex={0}
            aria-label={meeting.title}
            className={`group relative flex cursor-pointer flex-col gap-2 rounded-lg border p-3.5 focus-visible:outline-2 focus-visible:outline-primary transition-colors ${
              selected ? "border-primary bg-primary/10" : "border-base-content/15 bg-base-100 hover:bg-hover"
            } ${isAudioPending(meeting) && !progress ? "opacity-70" : ""}`}
          >
            <div className="flex items-start gap-1">
              <SelectBox
                meeting={meeting}
                checked={selected}
                onToggle={() => onToggle(meeting.id)}
                className={`-ml-2 -mt-1.5 ${selected || selectMode || selectedIds.length > 0 ? "" : "hidden group-hover:flex"}`}
              />
              <h2 className="line-clamp-2 min-w-0 flex-1 break-words font-semibold leading-snug">{meeting.title}</h2>
              <RowMenu
                meeting={meeting}
                className="-mr-1.5 -mt-1"
                onOpen={() => onOpen(meeting.id)}
                onRetranscribe={() => onRetranscribe(meeting.id)}
                onDelete={() => onDelete(meeting)}
              />
            </div>
            <p className="text-[13px] text-base-content/60" title={formatDate(meeting.startTime)}>
              {formatShortDate(meeting.startTime)} · {formatLength(meeting.endTime - meeting.startTime)} · {sourceLabel(meeting.source)}
            </p>
            <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
              <StatusPill meeting={meeting} progress={progress} onRetry={() => onRetranscribe(meeting.id)} />
              {meeting.primarySummaryArtifactId && <SummaryBadge />}
              <TagList tags={meeting.tags} max={3} />
            </div>
            {percent !== null && (
              <span className="block h-[3px] w-full overflow-hidden rounded-full bg-active" aria-hidden="true">
                <span className="block h-full bg-info transition-[width] duration-500" style={{ width: `${Math.max(4, percent)}%` }} />
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Mobile list                                                         */
/* ------------------------------------------------------------------ */

export function MeetingMobileList({
  meetings,
  progressMap,
  selectedIds,
  selectMode,
  grouped,
  onOpen,
  onToggle,
  onRetranscribe,
  onDelete,
}: MeetingViewProps & { grouped: boolean }): ReactElement {
  const now = new Date();
  const groups: { label: DateGroup | null; items: MeetingListItem[] }[] = [];
  for (const meeting of meetings) {
    const label = grouped ? dateGroup(meeting.startTime, now) : null;
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(meeting);
    else groups.push({ label, items: [meeting] });
  }
  return (
    <div className="-mx-4">
      {groups.map((group, gi) => (
        <section key={`${group.label ?? "all"}-${gi}`} aria-label={group.label ?? undefined}>
          {group.label && <h2 className="px-4 pt-3.5 pb-1.5 text-[13px] font-medium text-base-content/60">{group.label}</h2>}
          <ul>
            {group.items.map((meeting) => {
              const selected = selectedIds.includes(meeting.id);
              const progress = progressMap[meeting.id];
              const status = humanStatus(meeting, progress);
              const meta = [sourceLabel(meeting.source), ...meeting.tags].join(" · ");
              return (
                <li
                  key={meeting.id}
                  className={`flex items-center border-b border-divider ${selected ? "bg-primary/10" : ""} ${
                    isAudioPending(meeting) && !progress ? "opacity-70" : ""
                  }`}
                >
                  {selectMode && <SelectBox meeting={meeting} checked={selected} onToggle={() => onToggle(meeting.id)} className="ml-2" />}
                  <button
                    type="button"
                    onClick={() => (selectMode ? onToggle(meeting.id) : onOpen(meeting.id))}
                    className={`flex min-h-11 min-w-0 flex-1 flex-col gap-1 py-3 text-left active:bg-hover ${selectMode ? "pl-1" : "pl-4"}`}
                  >
                    <span className="flex w-full items-center gap-2">
                      <span className="min-w-0 flex-1 truncate font-semibold">{meeting.title}</span>
                      <span className="shrink-0 text-[13px] text-base-content/60">{formatLength(meeting.endTime - meeting.startTime)}</span>
                    </span>
                    <span className="flex w-full min-w-0 items-center gap-2 text-[13px]">
                      <span className={`${tagClass(status.color)} tag-dot shrink-0`} title={status.detail}>
                        {status.label}
                      </span>
                      <span className="min-w-0 truncate text-base-content/60">{meta}</span>
                    </span>
                    {status.percent !== null && (
                      <span className="block h-[3px] w-full overflow-hidden rounded-full bg-active" aria-hidden="true">
                        <span className="block h-full bg-info" style={{ width: `${Math.max(4, status.percent)}%` }} />
                      </span>
                    )}
                  </button>
                  <RowMenu
                    meeting={meeting}
                    className="mr-1 shrink-0"
                    onOpen={() => onOpen(meeting.id)}
                    onRetranscribe={() => onRetranscribe(meeting.id)}
                    onDelete={() => onDelete(meeting)}
                  />
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Loading skeleton                                                    */
/* ------------------------------------------------------------------ */

export function MeetingsSkeleton({ rows = 8 }: { rows?: number }): ReactElement {
  return (
    <div aria-busy="true" aria-label="Loading meetings" className="divide-y divide-[var(--divider)] border-y border-divider">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-4 py-3.5">
          <span className="hidden h-4 w-4 rounded bg-base-content/10 sm:block" />
          <span className="h-3.5 animate-pulse rounded bg-base-content/10" style={{ width: `${30 + ((i * 37) % 35)}%` }} />
          <span className="ml-auto hidden h-3.5 w-24 animate-pulse rounded bg-base-content/10 sm:block" />
          <span className="h-5 w-20 animate-pulse rounded bg-base-content/10" />
        </div>
      ))}
    </div>
  );
}
