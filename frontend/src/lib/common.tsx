import { useMemo } from "react";
import type { ReactElement } from "react";
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
      className={`prose prose-invert prose-stone max-w-none text-base-content prose-headings:font-semibold prose-headings:tracking-tight prose-headings:text-base-content prose-h1:text-xl prose-h1:border-b prose-h1:border-base-300 prose-h1:pb-2 prose-h2:text-lg prose-h2:border-b prose-h2:border-base-300/60 prose-h2:pb-1.5 prose-h3:text-base prose-h4:text-sm prose-p:leading-relaxed prose-p:my-3 prose-ul:my-2 prose-ul:list-disc prose-ol:my-2 prose-ol:list-decimal prose-li:my-1 prose-a:text-primary hover:prose-a:text-primary prose-strong:text-base-content prose-blockquote:border-l-2 prose-blockquote:border-primary/40 prose-blockquote:bg-base-200/60 prose-blockquote:py-1 prose-blockquote:px-4 prose-blockquote:rounded-r prose-blockquote:text-base-content prose-blockquote:not-italic prose-code:text-primary prose-code:bg-base-300/90 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:font-mono prose-code:text-xs prose-code:before:content-none prose-code:after:content-none prose-pre:bg-base-100 prose-pre:border prose-pre:border-base-300 prose-pre:rounded-xl prose-table:my-4 prose-table:w-full prose-table:text-left prose-th:border-b prose-th:border-base-300 prose-th:py-2 prose-th:px-3 prose-th:text-base-content prose-th:font-semibold prose-td:border-b prose-td:border-base-300 prose-td:py-2 prose-td:px-3 prose-hr:border-base-300 ${className}`}
      dangerouslySetInnerHTML={{ __html: renderedHtml }}
    />
  );
}
