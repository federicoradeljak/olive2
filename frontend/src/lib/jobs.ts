import type { TranscriptionProgressUpdate } from "../api/types.ts";
import type { DebugQueueJob, DebugQueuesSnapshot, DebugStageRun } from "../views/DebugQueues";

/* Plain-language names for the DBOS queues in backend workflows/queues.py. */
export const QUEUE_LABELS: Record<string, string> = {
  plaud_sync: "Syncing Plaud",
  ffmpeg: "Decoding audio",
  diarize: "Finding speakers",
  speaker_embed: "Matching voices",
  asr: "Transcribing",
  align: "Aligning words",
  speechmatics: "Transcribing with Speechmatics",
  assemblyai: "Transcribing with AssemblyAI",
  muse: "Transcribing with Muse",
  modal: "Transcribing on Modal GPU",
  summarize: "Writing summary",
};

/* Noun form of each queue, for the capacity tiles. */
export const QUEUE_TITLES: Record<string, string> = {
  plaud_sync: "Plaud sync",
  ffmpeg: "Audio decoding",
  diarize: "Speaker detection",
  speaker_embed: "Voice matching",
  asr: "Speech to text",
  align: "Word alignment",
  speechmatics: "Speechmatics",
  assemblyai: "AssemblyAI",
  muse: "Muse",
  modal: "Modal GPU",
  summarize: "Summaries",
};

/* Engine shown next to a job ("Local pipeline", "AssemblyAI", ...). */
const QUEUE_ENGINES: Record<string, string> = {
  plaud_sync: "Plaud",
  ffmpeg: "Local pipeline",
  diarize: "Local pipeline",
  speaker_embed: "Local pipeline",
  asr: "Local pipeline",
  align: "Local pipeline",
  speechmatics: "Speechmatics",
  assemblyai: "AssemblyAI",
  muse: "Muse",
  modal: "Modal GPU",
  summarize: "Summary",
};

export function queueLabel(queueName: string | null | undefined): string {
  if (!queueName) return "Background job";
  return QUEUE_LABELS[queueName] ?? queueName.replace(/_/g, " ");
}

export function queueTitle(queueName: string): string {
  return QUEUE_TITLES[queueName] ?? queueName.replace(/_/g, " ");
}

export function queueEngine(queueName: string | null | undefined): string {
  if (!queueName) return "Background";
  return QUEUE_ENGINES[queueName] ?? queueName.replace(/_/g, " ");
}

export function describeJob(job: DebugQueueJob): string {
  const what = queueLabel(job.queueName);
  return job.meetingTitle ? `${what} · ${job.meetingTitle}` : what;
}

/* Local transcription is a flat stage hand-off:
   ffmpeg_decode -> diarize -> {speaker_embed || asr} -> align. */
export interface LocalStep {
  key: string;
  label: string;
  queues: string[];
  stages: string[];
}

export const LOCAL_STEPS: LocalStep[] = [
  { key: "decode", label: "Decode audio", queues: ["ffmpeg"], stages: ["ffmpeg_decode"] },
  { key: "speakers", label: "Find speakers", queues: ["diarize"], stages: ["diarize"] },
  { key: "transcribe", label: "Voices & speech to text", queues: ["speaker_embed", "asr"], stages: ["speaker_embed", "asr"] },
  { key: "align", label: "Align words", queues: ["align"], stages: ["align"] },
];

const LOCAL_QUEUES = new Set(LOCAL_STEPS.flatMap((s) => s.queues));
const LOCAL_STAGES = new Set(LOCAL_STEPS.flatMap((s) => s.stages));
const TRANSCRIPTION_QUEUES = new Set([...LOCAL_QUEUES, "speechmatics", "assemblyai", "muse", "modal"]);

export type JobKind = "transcription" | "summary" | "sync" | "other";

export function jobKind(queueName: string | null | undefined): JobKind {
  if (!queueName) return "other";
  if (TRANSCRIPTION_QUEUES.has(queueName)) return "transcription";
  if (queueName === "summarize") return "summary";
  if (queueName === "plaud_sync") return "sync";
  return "other";
}

/* Tag color per job kind (see `tag-<color>` in styles.css). */
export const KIND_COLOR: Record<JobKind, string> = {
  transcription: "blue",
  summary: "purple",
  sync: "green",
  other: "gray",
};

const PROGRESS_FINISHED = new Set(["done", "error", "cancelled", "queued"]);

/** One user-facing unit of background work: a meeting's local pipeline
    (several stage jobs), or a single queue job. */
export interface ActivityItem {
  key: string;
  kind: JobKind;
  state: "running" | "queued";
  queueName: string | null;
  meetingId: string | null;
  meetingTitle: string | null;
  local: boolean;
  jobs: DebugQueueJob[];
  stageRuns: DebugStageRun[];
  progress: TranscriptionProgressUpdate | null;
  /* Index into LOCAL_STEPS of the step currently running (local only). */
  stepIndex: number;
  elapsedMs: number | null;
  queuePosition: number | null;
}

function maxElapsed(values: Array<number | null | undefined>): number | null {
  const nums = values.filter((v): v is number => typeof v === "number");
  return nums.length ? Math.max(...nums) : null;
}

function localStepIndex(queues: string[], stages: string[]): number {
  let idx = -1;
  LOCAL_STEPS.forEach((step, i) => {
    if (idx === -1 && (step.queues.some((q) => queues.includes(q)) || step.stages.some((s) => stages.includes(s)))) idx = i;
  });
  return Math.max(idx, 0);
}

export function buildActivity(snapshot: DebugQueuesSnapshot | null): { running: ActivityItem[]; queued: ActivityItem[] } {
  if (!snapshot) return { running: [], queued: [] };
  const progressMap = snapshot.activeTranscriptions ?? {};
  const running: ActivityItem[] = [];
  const localByMeeting = new Map<string, ActivityItem>();

  const localItem = (meetingId: string, meetingTitle: string | null): ActivityItem => {
    let item = localByMeeting.get(meetingId);
    if (!item) {
      item = {
        key: `local:${meetingId}`,
        kind: "transcription",
        state: "running",
        queueName: null,
        meetingId,
        meetingTitle,
        local: true,
        jobs: [],
        stageRuns: [],
        progress: progressMap[meetingId] ?? null,
        stepIndex: 0,
        elapsedMs: null,
        queuePosition: null,
      };
      localByMeeting.set(meetingId, item);
      running.push(item);
    }
    if (!item.meetingTitle && meetingTitle) item.meetingTitle = meetingTitle;
    return item;
  };

  for (const q of snapshot.queues) {
    for (const job of q.activeJobs) {
      if (job.meetingId && LOCAL_QUEUES.has(q.name)) {
        localItem(job.meetingId, job.meetingTitle).jobs.push(job);
        continue;
      }
      running.push({
        key: job.workflowId,
        kind: jobKind(q.name),
        state: "running",
        queueName: q.name,
        meetingId: job.meetingId,
        meetingTitle: job.meetingTitle,
        local: false,
        jobs: [job],
        stageRuns: [],
        progress: job.meetingId && jobKind(q.name) === "transcription" ? (progressMap[job.meetingId] ?? null) : null,
        stepIndex: 0,
        elapsedMs: job.elapsedMs,
        queuePosition: null,
      });
    }
  }

  for (const sr of snapshot.runningStageRuns ?? []) {
    if (LOCAL_STAGES.has(sr.stage)) {
      localItem(sr.meetingId, sr.meetingTitle).stageRuns.push(sr);
      continue;
    }
    const owner = running.find((r) => r.meetingId === sr.meetingId && r.kind === "transcription");
    if (owner) owner.stageRuns.push(sr);
  }

  for (const item of localByMeeting.values()) {
    item.stepIndex = localStepIndex(
      item.jobs.map((j) => j.queueName ?? ""),
      item.stageRuns.map((s) => s.stage),
    );
    item.elapsedMs = maxElapsed([...item.jobs.map((j) => j.elapsedMs), ...item.stageRuns.map((s) => s.elapsedMs)]);
  }

  // Transcriptions reporting progress without a running queue job (e.g. a
  // cloud provider waiting on its webhook).
  for (const [meetingId, prog] of Object.entries(progressMap)) {
    if (PROGRESS_FINISHED.has(prog.stage)) continue;
    if (running.some((r) => r.meetingId === meetingId && r.kind === "transcription")) continue;
    const titled = running.find((r) => r.meetingId === meetingId);
    running.push({
      key: `progress:${meetingId}`,
      kind: "transcription",
      state: "running",
      queueName: null,
      meetingId,
      meetingTitle: titled?.meetingTitle ?? null,
      local: false,
      jobs: [],
      stageRuns: [],
      progress: prog,
      stepIndex: 0,
      elapsedMs: null,
      queuePosition: null,
    });
  }

  const queued: ActivityItem[] = [];
  for (const q of snapshot.queues) {
    for (const job of q.waitingJobs) {
      // A later stage of a pipeline already shown as running.
      const owner = job.meetingId && LOCAL_QUEUES.has(q.name) ? localByMeeting.get(job.meetingId) : undefined;
      if (owner) {
        owner.jobs.push(job);
        continue;
      }
      queued.push({
        key: job.workflowId,
        kind: jobKind(q.name),
        state: "queued",
        queueName: q.name,
        meetingId: job.meetingId,
        meetingTitle: job.meetingTitle,
        local: LOCAL_QUEUES.has(q.name),
        jobs: [job],
        stageRuns: [],
        progress: null,
        stepIndex: 0,
        elapsedMs: job.waitingMs,
        queuePosition: job.queuePosition,
      });
    }
  }
  queued.sort((a, b) => (a.jobs[0]?.createdAt ?? 0) - (b.jobs[0]?.createdAt ?? 0));

  return { running, queued };
}

/** Sentence title for an activity item, e.g. `Transcribing "Weekly sync"`. */
export function activityTitle(item: ActivityItem): string {
  const meeting = item.meetingTitle ? `"${item.meetingTitle}"` : item.meetingId ? "a meeting" : "";
  switch (item.kind) {
    case "transcription":
      return meeting ? `Transcribing ${meeting}` : "Transcribing";
    case "summary":
      return meeting ? `Writing summary for ${meeting}` : "Writing summary";
    case "sync":
      return "Syncing Plaud";
    default:
      return meeting ? `${queueLabel(item.queueName)} · ${meeting}` : queueLabel(item.queueName);
  }
}

/** Engine shown for an item: "Local pipeline", "AssemblyAI", ... */
export function activityEngine(item: ActivityItem): string {
  if (item.local) return "Local pipeline";
  return item.queueName ? queueEngine(item.queueName) : "Transcription";
}

/** Fraction 0..1 of progress, when the backend reports one. */
export function activityFraction(item: ActivityItem): number | null {
  const p = item.progress;
  if (!p) return null;
  if (p.current != null && p.total) return Math.min(1, Math.max(0, p.current / p.total));
  if (typeof p.percent === "number" && p.percent > 0) return Math.min(1, p.percent / 100);
  return null;
}

export function formatElapsed(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec} s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ${sec % 60} s`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

/** Secondary line: engine, progress message and elapsed or waiting time. */
export function activityMeta(item: ActivityItem): string {
  const parts: string[] = [activityEngine(item)];
  if (item.state === "queued") {
    parts.push(item.queuePosition != null ? (item.queuePosition <= 1 ? "next in line" : `#${item.queuePosition} in line`) : "queued");
    if (item.elapsedMs) parts.push(`waiting ${formatElapsed(item.elapsedMs)}`);
    return parts.join(" · ");
  }
  if (item.progress?.message) parts.push(item.progress.message);
  if (item.elapsedMs != null) parts.push(formatElapsed(item.elapsedMs));
  return parts.join(" · ");
}
