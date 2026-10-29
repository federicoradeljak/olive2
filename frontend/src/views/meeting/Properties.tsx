import { useEffect, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { Sparkles, X } from "lucide-react";
import type { MeetingUsageResponse } from "../../api/types.ts";
import { MeetingDetailResponse, formatDate, toDatetimeLocalValue } from "../../lib/common";
import { formatUsageUsd } from "../Usage";
import { speakerTone, Spinner } from "./kit";
import { formatClock, sourceLabel, type SpeakerStat } from "./transcript";

const TAG_TONES = ["orange", "yellow", "blue", "purple", "pink", "green", "brown", "red"];
export function tagTone(tag: string): string {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) hash = (hash * 33 + tag.charCodeAt(i)) | 0;
  return TAG_TONES[Math.abs(hash) % TAG_TONES.length];
}

/** Big Notion-style title, click to edit; Enter saves, Escape cancels. */
export function MeetingTitle({
  title,
  onSave,
  onSuggest,
  suggesting,
  editing,
  onEditingChange
}: {
  title: string;
  onSave: (title: string) => Promise<boolean>;
  onSuggest: () => void;
  suggesting: boolean;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
}): ReactElement {
  const [draft, setDraft] = useState(title);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (editing) setDraft(title);
    // Only reset the draft when editing starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const commit = async () => {
    if (saving) return;
    const next = draft.trim();
    if (!next || next === title) {
      onEditingChange(false);
      return;
    }
    setSaving(true);
    const ok = await onSave(next);
    setSaving(false);
    if (ok) onEditingChange(false);
  };

  return (
    <div className="flex items-start gap-2">
      {editing ? (
        <textarea
          value={draft}
          rows={1}
          onChange={(e) => setDraft(e.target.value.replace(/\n/g, " "))}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commit();
            }
            if (e.key === "Escape") onEditingChange(false);
          }}
          onBlur={() => void commit()}
          aria-label="Meeting title"
          autoFocus
          disabled={saving}
          className="field-sizing-content min-w-0 flex-1 resize-none rounded-md bg-transparent text-[26px] font-bold leading-tight tracking-tight outline-none ring-primary/40 focus:ring-2 lg:text-[34px]"
        />
      ) : (
        <h1
          className="min-w-0 flex-1 cursor-text break-words rounded-md text-[26px] font-bold leading-tight tracking-tight hover:bg-hover lg:text-[34px]"
          onClick={() => {
            setDraft(title);
            onEditingChange(true);
          }}
          title="Click to rename"
        >
          {title}
        </h1>
      )}
      <button
        type="button"
        onClick={onSuggest}
        disabled={suggesting || editing}
        title="Suggest a title from the transcript"
        className="btn btn-ghost btn-sm mt-1 min-h-11 shrink-0 gap-1.5 font-normal text-base-content/60 lg:mt-1.5 lg:min-h-0"
      >
        {suggesting ? <Spinner className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />}
        <span className="hidden sm:inline">{suggesting ? "Suggesting…" : "Suggest title"}</span>
      </button>
    </div>
  );
}

function PropRow({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <>
      <dt className="flex min-h-[34px] items-center pl-1 text-base-content/55">{label}</dt>
      <dd className="flex min-h-[34px] min-w-0 flex-wrap items-center gap-1.5 rounded px-2">{children}</dd>
    </>
  );
}

export function PropertyList({
  detail,
  stats,
  durationMs,
  languageLabel,
  usage,
  onSaveStartTime,
  onSaveTags,
  savingTags,
  onOpenSpeakers
}: {
  detail: MeetingDetailResponse;
  stats: SpeakerStat[];
  durationMs: number | null;
  languageLabel: string | null;
  usage: MeetingUsageResponse | null;
  onSaveStartTime: (ms: number) => Promise<boolean>;
  onSaveTags: (tags: string[]) => void;
  savingTags: boolean;
  onOpenSpeakers: () => void;
}): ReactElement {
  const [editingDate, setEditingDate] = useState(false);
  const [dateDraft, setDateDraft] = useState("");
  const [savingDate, setSavingDate] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const meeting = detail.meeting;

  const saveDate = async () => {
    const ms = new Date(dateDraft).getTime();
    if (!dateDraft || Number.isNaN(ms)) return;
    setSavingDate(true);
    const ok = await onSaveStartTime(ms);
    setSavingDate(false);
    if (ok) setEditingDate(false);
  };

  const addTag = () => {
    const tag = tagDraft.trim();
    setTagDraft("");
    if (!tag || meeting.tags.includes(tag)) return;
    onSaveTags([...meeting.tags, tag]);
  };

  const costNote =
    usage && usage.eventCount > 0
      ? usage.transcriptionCostUsd > 0 && usage.llmCostUsd > 0
        ? `· transcription ${formatUsageUsd(usage.transcriptionCostUsd)} · AI ${formatUsageUsd(usage.llmCostUsd)}`
        : usage.llmCostUsd > 0
        ? "· AI only"
        : "· transcription only"
      : null;

  return (
    <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-y-0.5 text-sm sm:grid-cols-[150px_minmax(0,1fr)]">
      <PropRow label="Date">
        {editingDate ? (
          <form
            className="flex flex-wrap items-center gap-1.5 py-1"
            onSubmit={(e) => {
              e.preventDefault();
              void saveDate();
            }}
          >
            <input
              type="datetime-local"
              value={dateDraft}
              onChange={(e) => setDateDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setEditingDate(false);
              }}
              aria-label="Meeting start time"
              autoFocus
              disabled={savingDate}
              className="input input-sm h-11 lg:h-8"
            />
            <button type="submit" disabled={savingDate} className="btn btn-primary btn-sm min-h-11 lg:min-h-0">
              {savingDate ? "Saving…" : "Save"}
            </button>
            <button type="button" onClick={() => setEditingDate(false)} disabled={savingDate} className="btn btn-ghost btn-sm min-h-11 lg:min-h-0">
              Cancel
            </button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => {
              setDateDraft(toDatetimeLocalValue(meeting.startTime));
              setEditingDate(true);
            }}
            title="Change date and time"
            className="-mx-2 min-h-[34px] rounded px-2 text-left hover:bg-hover"
          >
            {formatDate(meeting.startTime)}
          </button>
        )}
      </PropRow>
      <PropRow label="Length">{durationMs ? formatClock(durationMs) : "—"}</PropRow>
      <PropRow label="Source">
        <span>{sourceLabel(meeting.source)}</span>
        <span className="text-base-content/50">· imported {formatDate(meeting.createdAt)}</span>
      </PropRow>
      <PropRow label="People">
        {stats.length === 0 ? (
          <span className="text-base-content/40">Empty</span>
        ) : (
          stats.map((s) => (
            <button key={s.label} type="button" onClick={onOpenSpeakers} className={`tag tag-${speakerTone(s.label)} hover:opacity-80`}>
              {s.label}
            </button>
          ))
        )}
      </PropRow>
      <PropRow label="Tags">
        {meeting.tags.map((tag) => (
          <span key={tag} className={`tag tag-${tagTone(tag)} group pr-1`}>
            {tag}
            <button
              type="button"
              onClick={() => onSaveTags(meeting.tags.filter((t) => t !== tag))}
              disabled={savingTags}
              aria-label={`Remove tag ${tag}`}
              className="inline-flex h-4 w-4 items-center justify-center rounded-sm opacity-60 hover:opacity-100 disabled:opacity-30"
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          </span>
        ))}
        <input
          type="text"
          value={tagDraft}
          onChange={(e) => setTagDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addTag();
            }
          }}
          onBlur={() => {
            if (tagDraft.trim()) addTag();
          }}
          placeholder={meeting.tags.length ? "Add tag" : "Add a tag"}
          aria-label="Add tag"
          disabled={savingTags}
          className="h-7 w-24 min-w-0 rounded bg-transparent px-1 text-sm outline-none placeholder:text-base-content/40 focus:w-36 focus:bg-hover"
        />
      </PropRow>
      {languageLabel && <PropRow label="Language">{languageLabel}</PropRow>}
      {usage && usage.eventCount > 0 && (
        <PropRow label="Cost">
          <span title="Estimated cloud spend for this meeting (transcription per audio hour, AI per token)">≈ {formatUsageUsd(usage.totalCostUsd)}</span>
          {costNote && <span className="text-base-content/50">{costNote}</span>}
        </PropRow>
      )}
    </dl>
  );
}

/** Compact property chips for phones (full list lives in the Details sheet). */
export function PropertyChips({
  detail,
  durationMs,
  languageLabel
}: {
  detail: MeetingDetailResponse;
  durationMs: number | null;
  languageLabel: string | null;
}): ReactElement {
  const start = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(detail.meeting.startTime));
  return (
    <div className="flex flex-wrap gap-1.5 text-[13px]">
      <span className="rounded bg-hover px-2">{start}</span>
      {durationMs ? <span className="rounded bg-hover px-2">{formatClock(durationMs)}</span> : null}
      {languageLabel && <span className="rounded bg-hover px-2">{languageLabel}</span>}
      {detail.meeting.tags.map((tag) => (
        <span key={tag} className={`tag tag-${tagTone(tag)}`}>
          {tag}
        </span>
      ))}
    </div>
  );
}
