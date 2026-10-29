import type { MeetingListItem, TranscriptionProgressUpdate } from "../../api/types.ts";

export type TagColor = "gray" | "brown" | "orange" | "yellow" | "green" | "blue" | "purple" | "pink" | "red";

const TAG_COLORS: TagColor[] = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];

/** Stable Notion tag color for a tag name (case-insensitive). */
export function tagColor(name: string): TagColor {
  const key = name.trim().toLowerCase();
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length];
}

export function tagClass(color: TagColor): string {
  return color === "gray" ? "tag" : `tag tag-${color}`;
}

export const SOURCE_LABELS: Record<MeetingListItem["source"], string> = {
  plaud: "Plaud",
  upload: "Upload",
  "ios-shortcut": "iOS Shortcut",
};

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source as MeetingListItem["source"]] ?? source;
}

/** Compact date for lists: "Oct 28, 10:00" (year added when not the current one). */
export function formatShortDate(timestamp: number): string {
  const d = new Date(timestamp);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

/** Clock-style length: "48:12" or "1:12:30". */
export function formatLength(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export interface HumanStatus {
  label: string;
  color: TagColor;
  /** 0-100 while a stage reports measurable progress. */
  percent: number | null;
  /** Failed meetings can be re-transcribed from the pill. */
  retry: boolean;
  /** Extra detail for the tooltip. */
  detail?: string;
}

const STAGE_LABELS: Partial<Record<TranscriptionProgressUpdate["stage"], string>> = {
  decoding: "Preparing audio",
  uploading: "Uploading",
  diarizing: "Finding speakers",
  transcribing: "Transcribing",
  finalizing: "Finishing up",
};

/** Map raw meeting/audio/progress states to plain words. */
export function humanStatus(meeting: MeetingListItem, progress: TranscriptionProgressUpdate | undefined): HumanStatus {
  if (progress) {
    const pct = Math.max(0, Math.min(100, Math.round(progress.percent)));
    switch (progress.stage) {
      case "queued":
        return { label: "Queued", color: "yellow", percent: null, retry: false, detail: progress.message };
      case "error":
        return { label: "Failed · retry", color: "red", percent: null, retry: true, detail: progress.error || progress.message };
      case "cancelled":
        return { label: "Cancelled", color: "gray", percent: null, retry: false, detail: progress.message };
      case "done":
        return { label: "Finishing up", color: "blue", percent: 100, retry: false, detail: progress.message };
      default: {
        const stageLabel = STAGE_LABELS[progress.stage] ?? "Transcribing";
        return { label: `${stageLabel} · ${pct}%`, color: "blue", percent: pct, retry: false, detail: progress.message };
      }
    }
  }
  if (meeting.audioStatus === "retrieving") {
    return { label: "Fetching audio", color: "gray", percent: null, retry: false, detail: "Audio is still downloading" };
  }
  if (meeting.audioStatus === "missing") {
    return { label: "Audio missing", color: "red", percent: null, retry: false, detail: "The recording could not be found" };
  }
  switch (meeting.status) {
    case "ready":
      return { label: "Ready", color: "green", percent: null, retry: false };
    case "processing":
      return { label: "Processing", color: "blue", percent: null, retry: false };
    case "error":
      return { label: "Failed · retry", color: "red", percent: null, retry: true, detail: meeting.lastError ?? undefined };
    case "duplicate":
      return { label: "Duplicate", color: "gray", percent: null, retry: false };
    default:
      return { label: "Not transcribed", color: "gray", percent: null, retry: false, detail: meeting.lastError ?? undefined };
  }
}

export type DateGroup = "Today" | "This week" | "Earlier";

export function dateGroup(timestamp: number, now = new Date()): DateGroup {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (timestamp >= startOfToday) return "Today";
  if (timestamp >= startOfToday - 6 * 24 * 60 * 60 * 1000) return "This week";
  return "Earlier";
}
