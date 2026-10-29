import type { MeetingSummaryItem } from "../../api/types.ts";
import { formatTimeOffset, isGenericSpeakerLabel } from "../../lib/common";
import { languageOptions } from "../../components/OptionComboboxes";

export interface TranscriptTurn {
  speaker: string;
  text: string;
  startMs: number;
  endMs: number;
  verified?: boolean;
  segmentIndex: number;
}

export interface ParsedTranscript {
  turns: TranscriptTurn[];
  language: string | null;
}

/** Parse the stored transcript JSON (normalized `{segments}` or a legacy bare array). */
export function parseTranscript(content: string | null | undefined): ParsedTranscript {
  if (!content) return { turns: [], language: null };
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed?.segments)) {
      return {
        language: typeof parsed.language === "string" && parsed.language ? parsed.language : null,
        turns: parsed.segments.map((s: any, idx: number) => ({
          speaker: s.speaker || "Speaker",
          text: s.text || s.content || "",
          startMs: s.startMs ?? s.start_time ?? 0,
          endMs: s.endMs ?? s.end_time ?? 0,
          verified: Boolean(s.verified),
          segmentIndex: idx
        }))
      };
    }
    if (Array.isArray(parsed)) {
      return {
        language: null,
        turns: parsed
          .filter((item: any) => (item.text && item.text.trim()) || (item.content && item.content.trim()))
          .map((item: any, idx: number) => ({
            speaker: item.speaker || "Speaker",
            text: item.text || item.content || "",
            startMs: item.startMs ?? item.start_time ?? 0,
            endMs: item.endMs ?? item.end_time ?? 0,
            verified: Boolean(item.verified),
            segmentIndex: idx
          }))
      };
    }
  } catch {
    // plain text fallback
  }
  return { turns: [], language: null };
}

/** Index of the turn playing at `ms` (turns are chronological), or null. */
export function turnIndexAt(turns: TranscriptTurn[], ms: number): number | null {
  let lo = 0;
  let hi = turns.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (turns[mid].startMs <= ms) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found < 0) return null;
  const t = turns[found];
  // Small grace after the end so short gaps between turns don't flicker.
  return ms <= Math.max(t.endMs, t.startMs) + 1500 ? found : null;
}

export type SpeakerStatus = "verified" | "likely" | "unknown";

export interface SpeakerStat {
  label: string;
  talkMs: number;
  share: number;
  turns: number;
  verifiedTurns: number;
  firstSegmentIndex: number;
  status: SpeakerStatus;
}

/** Talk time per transcript label, largest first. */
export function speakerStats(turns: TranscriptTurn[]): SpeakerStat[] {
  const byLabel = new Map<string, SpeakerStat>();
  let total = 0;
  for (const t of turns) {
    const dur = Math.max(0, t.endMs - t.startMs);
    total += dur;
    const key = t.speaker;
    const cur = byLabel.get(key) ?? {
      label: key,
      talkMs: 0,
      share: 0,
      turns: 0,
      verifiedTurns: 0,
      firstSegmentIndex: t.segmentIndex,
      status: "likely" as SpeakerStatus
    };
    cur.talkMs += dur;
    cur.turns += 1;
    if (t.verified) cur.verifiedTurns += 1;
    byLabel.set(key, cur);
  }
  const list = [...byLabel.values()];
  for (const s of list) {
    s.share = total > 0 ? s.talkMs / total : 0;
    s.status = isGenericSpeakerLabel(s.label) ? "unknown" : s.verifiedTurns > 0 ? "verified" : "likely";
  }
  return list.sort((a, b) => b.talkMs - a.talkMs);
}

export function turnStatus(turn: TranscriptTurn): SpeakerStatus {
  if (turn.verified) return "verified";
  return isGenericSpeakerLabel(turn.speaker) ? "unknown" : "likely";
}

export function transcriptToText(turns: TranscriptTurn[]): string {
  return turns.map((t) => `[${formatTimeOffset(t.startMs)}] ${t.speaker}: ${t.text}`).join("\n\n") + "\n";
}

export function transcriptToMarkdown(title: string, turns: TranscriptTurn[]): string {
  const body = turns.map((t) => `**${t.speaker}** · \`${formatTimeOffset(t.startMs)}\`\n\n${t.text}`).join("\n\n");
  return `# ${title}\n\n${body}\n`;
}

/** "H:MM:SS" for long recordings, "MM:SS" otherwise. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

const LANGUAGE_NAMES = new Map(
  languageOptions("", "").filter((o) => o.value && o.value !== "auto").map((o) => [o.value, o.label])
);

export function languageName(code: string | null | undefined): string | null {
  if (!code) return null;
  const base = code.toLowerCase().split(/[-_]/)[0];
  return LANGUAGE_NAMES.get(code) ?? LANGUAGE_NAMES.get(base) ?? code;
}

export interface SummaryLabel {
  template: string;
  provider: string;
  model: string;
}

/** Summary artifacts store `provider:model:template` in their provider column. */
export function summaryLabel(summary: Pick<MeetingSummaryItem, "provider">): SummaryLabel {
  const parts = summary.provider.split(":");
  return {
    provider: parts[0] ?? "",
    model: parts[1] ?? "",
    template: parts.slice(2).join(":") || "Summary"
  };
}

export function formatShortDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(timestamp));
}

export function sourceLabel(source: string): string {
  if (source === "plaud") return "Plaud";
  if (source === "upload") return "Upload";
  if (source === "ios-shortcut") return "iOS Shortcut";
  return source;
}

export function transcriptEngineLabel(provider: string | null | undefined): string | null {
  if (!provider) return null;
  const p = provider.toLowerCase();
  if (p.startsWith("local")) return "Local pipeline";
  if (p.startsWith("speechmatics")) return "Speechmatics";
  if (p.startsWith("assemblyai")) return "AssemblyAI";
  if (p.startsWith("muse")) return "Muse Voice";
  if (p.startsWith("modal")) return "Modal GPU";
  if (p.startsWith("plaud")) return "Plaud";
  return provider;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
