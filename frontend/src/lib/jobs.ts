import type { DebugQueueJob } from "../views/DebugQueues";

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

export function queueLabel(queueName: string | null | undefined): string {
  if (!queueName) return "Background job";
  return QUEUE_LABELS[queueName] ?? queueName.replace(/_/g, " ");
}

export function describeJob(job: DebugQueueJob): string {
  const what = queueLabel(job.queueName);
  return job.meetingTitle ? `${what} · ${job.meetingTitle}` : what;
}
