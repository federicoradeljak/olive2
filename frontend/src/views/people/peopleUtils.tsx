import type { ReactElement } from "react";
import type { Speaker } from "../../api/types.ts";

export const MAX_VOICE_SAMPLES = 8;

export interface SpeakerMeetingLink {
  id: string;
  title: string;
  startTime: number;
}

export interface SpeakerDetailResponse {
  speaker: Speaker;
  meetings: SpeakerMeetingLink[];
}

const AVATAR_COLORS = ["green", "purple", "blue", "orange", "yellow", "pink", "brown", "red"] as const;

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

/* Stable per-person color so the same avatar reads the same everywhere. */
export function avatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export function Avatar({ speaker, size = "md" }: { speaker: Pick<Speaker, "id" | "name">; size?: "md" | "lg" }): ReactElement {
  const sizing = size === "lg" ? "h-16 w-16 text-2xl sm:h-[72px] sm:w-[72px] sm:text-[26px]" : "h-8 w-8 text-xs";
  return (
    <span
      aria-hidden="true"
      className={`tag tag-${avatarColor(speaker.id)} inline-flex shrink-0 items-center justify-center !rounded-full !p-0 font-semibold ${sizing}`}
    >
      {initials(speaker.name)}
    </span>
  );
}

export function hasVoice(speaker: Pick<Speaker, "providerIds" | "enrollmentClipPaths">): boolean {
  return (
    (speaker.providerIds?.local?.length ?? 0) > 0 ||
    (speaker.providerIds?.speechmatics?.length ?? 0) > 0 ||
    (speaker.enrollmentClipPaths?.length ?? 0) > 0
  );
}

/* Filled sample slots: stored clips, or (for voiceprints imported without
   audio) the number of local vectors. */
export function voiceSampleCount(speaker: Pick<Speaker, "providerIds" | "enrollmentClipPaths">): number {
  const clips = speaker.enrollmentClipPaths?.length ?? 0;
  const vectors = speaker.providerIds?.local?.length ?? 0;
  return Math.min(MAX_VOICE_SAMPLES, Math.max(clips, vectors));
}

export function VoiceDots({ count }: { count: number }): ReactElement {
  return (
    <span className="flex shrink-0 gap-0.5" aria-hidden="true">
      {Array.from({ length: MAX_VOICE_SAMPLES }, (_, i) => (
        <span key={i} className={`h-3 w-1 rounded-sm ${i < count ? "bg-primary" : "bg-active"}`} />
      ))}
    </span>
  );
}

export interface ClipSource {
  meetingId: string | null;
  learnedAt: number | null;
}

/* Clip files are named clip_meeting_<meetingId>_<ts>.wav or
   clip_rapid_meeting_<meetingId>_<idx>_<ts>.wav by the backend. */
export function parseClipSource(path: string): ClipSource {
  const file = path.split("/").pop() ?? path;
  const match = /^clip_(?:rapid_)?meeting_([0-9a-f-]{36})_(?:\d+_)?(\d{12,})\.wav$/i.exec(file);
  if (match) return { meetingId: match[1], learnedAt: Number(match[2]) };
  const ts = /_(\d{12,})\.\w+$/.exec(file);
  return { meetingId: null, learnedAt: ts ? Number(ts[1]) : null };
}

export function shortDate(ts: number): string {
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(undefined, sameYear ? { month: "short", day: "numeric" } : { dateStyle: "medium" }).format(d);
}

/* fetch + JSON with the backend's `{ error }` convention surfaced as an Error. */
export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // empty or non-JSON body
  }
  if (!res.ok) {
    const message = (data as { error?: string } | null)?.error;
    throw new Error(message || `HTTP ${res.status}`);
  }
  return data as T;
}

export function postJson<T>(url: string, body?: unknown): Promise<T> {
  return requestJson<T>(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}
