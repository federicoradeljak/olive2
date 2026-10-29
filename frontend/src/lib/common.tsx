import { useMemo } from "react";
import type { CSSProperties, ReactElement } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import type { MeetingDetailAggregate, MeetingListItem, Speaker } from "../api/types.ts";

export interface MeetingsResponse {
  meetings: MeetingListItem[];
  pagination: {
    limit: number;
    offset: number;
    total: number;
    hasMore?: boolean;
    nextOffset?: number | null;
  };
}

export const MEETINGS_PAGE_SIZE = 100;

export type MeetingDetailResponse = MeetingDetailAggregate;

export interface SpeakerWithStats extends Speaker {
  meetingCount: number;
}

// Unidentified diarization labels ("Speaker 1", "S1", "Unknown", ...) are
// transcript labels, not people: never list them in People or as assignable
// persons. Mirrors backend olive/speaker_labels.py (defense in depth for
// speaker rows persisted before that rule existed).
export const GENERIC_SPEAKER_RE = /^(?:(?:speaker|speakers)(?:[\s_-]*#?(?:\d+|[a-z]{1,2}))?|(?:spk|participant|person|guest|unknown|uu)(?:[\s_-]*#?\d+)?|unknown[\s_-]+speaker(?:[\s_-]*#?\d+)?|s[\s_-]*\d+)$/i;
export function isGenericSpeakerLabel(name: string | null | undefined): boolean {
  return !name?.trim() || GENERIC_SPEAKER_RE.test(name.trim());
}

export interface PlaudStatus {
  connected: boolean;
  lastPollAt: number | null;
  pcsPending: number;
}

export function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(timestamp));
}

export function toDatetimeLocalValue(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  const hours = Math.floor(ms / (1000 * 60 * 60));

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m ${seconds}s`;
}

export function formatTimeOffset(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

marked.setOptions({
  gfm: true,
  breaks: true
});

/* Prose colors come from the active daisyUI theme so Markdown reads the same
   in light and dark (Notion-like: neutral text, olive links, gray code chips). */
const PROSE_THEME_VARS = {
  "--tw-prose-body": "color-mix(in oklab, var(--color-base-content) 92%, transparent)",
  "--tw-prose-headings": "var(--color-base-content)",
  "--tw-prose-lead": "var(--color-base-content)",
  "--tw-prose-links": "var(--color-primary)",
  "--tw-prose-bold": "var(--color-base-content)",
  "--tw-prose-counters": "color-mix(in oklab, var(--color-base-content) 55%, transparent)",
  "--tw-prose-bullets": "color-mix(in oklab, var(--color-base-content) 55%, transparent)",
  "--tw-prose-hr": "var(--divider)",
  "--tw-prose-quotes": "var(--color-base-content)",
  "--tw-prose-quote-borders": "var(--color-base-content)",
  "--tw-prose-captions": "color-mix(in oklab, var(--color-base-content) 60%, transparent)",
  "--tw-prose-kbd": "var(--color-base-content)",
  "--tw-prose-code": "var(--tag-red)",
  "--tw-prose-pre-code": "var(--color-base-content)",
  "--tw-prose-pre-bg": "var(--color-base-200)",
  "--tw-prose-th-borders": "color-mix(in oklab, var(--color-base-content) 16%, transparent)",
  "--tw-prose-td-borders": "var(--divider)",
} as CSSProperties;

export function MarkdownRenderer({ content, className = "" }: { content: string; className?: string }): ReactElement {
  const renderedHtml = useMemo(() => {
    if (!content) return "";
    try {
      const raw = marked.parse(content) as string;
      return DOMPurify.sanitize(raw, {
        USE_PROFILES: { html: true }
      });
    } catch {
      return content;
    }
  }, [content]);

  return (
    <div
      style={PROSE_THEME_VARS}
      className={`prose max-w-none text-[15px] leading-relaxed text-base-content prose-headings:font-semibold prose-headings:tracking-tight prose-h1:text-xl prose-h1:mt-6 prose-h2:text-lg prose-h2:mt-6 prose-h3:text-base prose-h4:text-sm prose-p:leading-relaxed prose-p:my-2.5 prose-ul:my-2 prose-ul:list-disc prose-ol:my-2 prose-ol:list-decimal prose-li:my-0.5 prose-a:font-normal prose-a:underline prose-a:decoration-base-content/30 prose-a:underline-offset-2 hover:prose-a:decoration-current prose-blockquote:border-l-[3px] prose-blockquote:py-0 prose-blockquote:pl-3.5 prose-blockquote:font-normal prose-blockquote:not-italic prose-code:bg-hover prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:font-mono prose-code:text-[0.85em] prose-code:font-normal prose-code:before:content-none prose-code:after:content-none prose-pre:rounded-lg prose-pre:border prose-pre:border-divider prose-table:my-4 prose-table:w-full prose-table:text-left prose-table:text-sm prose-th:py-2 prose-th:px-3 prose-th:font-medium prose-td:py-2 prose-td:px-3 prose-hr:my-6 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&>:first-child]:mt-0 ${className}`}
      dangerouslySetInnerHTML={{ __html: renderedHtml }}
    />
  );
}
