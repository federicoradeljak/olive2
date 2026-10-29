import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { Play, RotateCw } from "lucide-react";
import { Combobox } from "../../components/Combobox";
import type { MeetingDetailAggregate, MeetingListItem } from "../../api/types.ts";
import { MarkdownRenderer, isGenericSpeakerLabel } from "../../lib/common";
import type { MeetingsResponse } from "../../lib/common";

interface LlmConfigLite {
  defaultProvider?: string;
  defaultModel?: string;
}

interface GenerateResult {
  text: string;
  provider: string;
  model: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/* Mirrors the backend's strftime("%b %d, %Y, %I:%M %p") in services/summaries.py. */
function formatSummaryDate(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  const h12 = d.getHours() % 12 || 12;
  return `${MONTHS[d.getMonth()]} ${pad(d.getDate())}, ${d.getFullYear()}, ${pad(h12)}:${pad(d.getMinutes())} ${d.getHours() < 12 ? "AM" : "PM"}`;
}

function languageForPrompt(code: string): string {
  const value = code.trim();
  if (!value) return "";
  if (value.toLowerCase() === "auto") return "the same language as the transcript";
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(value.split("-")[0]) ?? value;
  } catch {
    return value;
  }
}

function formatDialogue(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    const segs = parsed && typeof parsed === "object" ? (parsed as { segments?: unknown }).segments : null;
    if (Array.isArray(segs)) {
      return segs
        .filter((s): s is { speaker?: string; text?: string } => !!s && typeof s === "object")
        .map((s) => `${s.speaker || "Unknown"}: ${s.text ?? ""}`)
        .join("\n\n");
    }
  } catch {
    // plain-text transcript
  }
  return raw;
}

/* Fills the template the same way summaries.py does, so a preview run is a
   faithful (not byte-exact) rehearsal of "Generate summary". */
function fillTemplate(
  systemPrompt: string,
  userPrompt: string,
  detail: MeetingDetailAggregate,
  languageCode: string,
): { system: string; prompt: string } {
  const language = languageForPrompt(languageCode);
  const speakers = detail.speakers.map((s) => s.name).filter((n) => !isGenericSpeakerLabel(n)).join(", ") || "Participants";
  const vars: Record<string, string> = {
    "{{title}}": detail.meeting.title,
    "{{date}}": formatSummaryDate(detail.meeting.startTime),
    "{{speakers}}": speakers,
    "{{language}}": language,
    "{{transcript}}": formatDialogue(detail.transcriptContent ?? ""),
  };
  const replaceVars = (s: string) => Object.entries(vars).reduce((acc, [k, v]) => acc.split(k).join(v), s);
  let system = replaceVars(systemPrompt);
  const prompt = replaceVars(userPrompt);
  if (language && !`${systemPrompt}${userPrompt}`.includes("{{language}}")) {
    const instruction = `Write the entire response in ${language}.`;
    system = system ? `${system}\n\n${instruction}` : instruction;
  }
  return { system, prompt };
}

/* Runs the current (unsaved) template against a transcribed meeting through
   /api/llm/generate with the default model. Nothing is saved to the meeting. */
export function TemplatePreview({ systemPrompt, userPrompt }: { systemPrompt: string; userPrompt: string }): ReactElement {
  const [meetings, setMeetings] = useState<MeetingListItem[]>([]);
  const [meetingId, setMeetingId] = useState("");
  const [llm, setLlm] = useState<LlmConfigLite>({});
  const [summaryLanguage, setSummaryLanguage] = useState("");
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLElement>(null);

  // The panel opens below a long prompt: bring it into view.
  useEffect(() => {
    rootRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [mRes, llmRes, cfgRes] = await Promise.all([
          fetch("/api/meetings?limit=100&offset=0"),
          fetch("/api/llm/config"),
          fetch("/api/config"),
        ]);
        if (cancelled) return;
        if (mRes.ok) {
          const data = (await mRes.json()) as MeetingsResponse;
          const withTranscript = data.meetings.filter((m) => m.primaryTranscriptArtifactId);
          setMeetings(withTranscript);
          setMeetingId((prev) => prev || withTranscript[0]?.id || "");
        }
        if (llmRes.ok) setLlm((await llmRes.json()) as LlmConfigLite);
        if (cfgRes.ok) {
          const cfg = (await cfgRes.json()) as { defaultSummaryLanguage?: string };
          setSummaryLanguage(cfg.defaultSummaryLanguage || "");
        }
      } catch {
        // preview stays usable with whatever loaded
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const options = useMemo(
    () =>
      meetings.map((m) => ({
        value: m.id,
        label: m.title,
        description: new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(m.startTime)),
      })),
    [meetings],
  );

  const run = async () => {
    if (!meetingId || !userPrompt.trim()) return;
    setRunning(true);
    setError(null);
    try {
      const detailRes = await fetch(`/api/meetings/${meetingId}`);
      if (!detailRes.ok) throw new Error(`Could not load the meeting (HTTP ${detailRes.status})`);
      const detail = (await detailRes.json()) as MeetingDetailAggregate;
      if (!detail.transcriptContent) throw new Error("This meeting has no transcript yet.");
      const filled = fillTemplate(systemPrompt, userPrompt, detail, summaryLanguage);
      const res = await fetch("/api/llm/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ systemPrompt: filled.system || undefined, prompt: filled.prompt }),
      });
      const data = (await res.json()) as GenerateResult & { error?: string };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const languageLabel = languageForPrompt(summaryLanguage);

  return (
    <aside ref={rootRef} aria-label="Preview" className="flex min-w-0 flex-col gap-3 rounded-xl border border-divider bg-base-200 p-4 sm:p-5">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">Preview</span>
        <button
          type="button"
          onClick={() => void run()}
          disabled={running || !meetingId || !userPrompt.trim()}
          className="btn btn-sm min-h-11 gap-1.5 border-base-300 bg-base-100 font-normal shadow-none hover:bg-hover lg:min-h-8"
        >
          {running ? (
            <span className="loading loading-spinner loading-xs" aria-hidden="true" />
          ) : result ? (
            <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <Play className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {result ? "Run again" : "Run"}
        </button>
      </div>

      {meetings.length === 0 ? (
        <p className="text-sm text-base-content/60">Transcribe a meeting to preview this template against it.</p>
      ) : (
        <Combobox
          value={meetingId}
          onChange={setMeetingId}
          options={options}
          placeholder="Choose a meeting…"
          ariaLabel="Meeting to preview with"
          searchPlaceholder="Search meetings…"
          emptyText="No transcribed meetings match."
        />
      )}

      <span className="text-xs text-base-content/60">
        {[result ? `${result.provider} · ${result.model}` : llm.defaultModel ? `${llm.defaultProvider ?? ""} · ${llm.defaultModel}` : null, languageLabel || null]
          .filter(Boolean)
          .join(" · ")}
        {" "}Uses your unsaved edits. Nothing is saved to the meeting.
      </span>

      {error && <div className="alert alert-soft alert-error text-sm">{error}</div>}

      {result && (
        <div className="max-h-[32rem] min-w-0 overflow-y-auto rounded-lg border border-divider bg-base-100 px-4 py-3">
          <MarkdownRenderer content={result.text} className="prose-sm" />
        </div>
      )}
    </aside>
  );
}
