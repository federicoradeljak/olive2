import type { ReactElement, ReactNode } from "react";
import { Check, CircleAlert, RotateCw, X } from "lucide-react";
import type { TranscriptionProgressUpdate } from "../../api/types.ts";
import { formatTimeOffset } from "../../lib/common";
import { Spinner } from "./kit";

type Tone = "info" | "error" | "warning" | "success" | "neutral";

const TONE_CLASSES: Record<Tone, string> = {
  info: "bg-info/10 text-base-content",
  error: "bg-error/10 text-base-content",
  warning: "bg-warning/10 text-base-content",
  success: "bg-primary/10 text-base-content",
  neutral: "bg-hover text-base-content"
};

export function Banner({
  tone,
  icon,
  title,
  children,
  actions,
  onDismiss
}: {
  tone: Tone;
  icon?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  onDismiss?: () => void;
}): ReactElement {
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`flex flex-wrap items-start gap-x-3 gap-y-2 rounded-box px-4 py-3 text-sm ${TONE_CLASSES[tone]}`}>
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <div className="min-w-0 flex-1 basis-56">
        <p className="font-medium">{title}</p>
        {children && <div className="mt-0.5 text-base-content/70">{children}</div>}
      </div>
      {(actions || onDismiss) && (
        <div className="flex shrink-0 items-center gap-1.5">
          {actions}
          {onDismiss && (
            <button type="button" onClick={onDismiss} aria-label="Dismiss" className="btn btn-ghost btn-square btn-sm min-h-11 min-w-11 lg:min-h-0 lg:min-w-0">
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const STAGES: { key: string; label: string; matches: TranscriptionProgressUpdate["stage"][] }[] = [
  { key: "prepare", label: "Preparing audio", matches: ["queued", "decoding", "uploading"] },
  { key: "speakers", label: "Finding who spoke", matches: ["diarizing"] },
  { key: "transcribe", label: "Writing the transcript", matches: ["transcribing"] },
  { key: "finish", label: "Finishing up", matches: ["finalizing", "done"] }
];

const STAGE_MESSAGES: Partial<Record<TranscriptionProgressUpdate["stage"], string>> = {
  queued: "Waiting for a free worker",
  decoding: "Preparing and cleaning up the audio",
  uploading: "Uploading the audio",
  diarizing: "Finding who spoke when",
  transcribing: "Writing the transcript",
  finalizing: "Putting it all together"
};

export function TranscriptionBanner({
  progress,
  engineLabel,
  transcribing,
  cancelling,
  onCancel
}: {
  progress: TranscriptionProgressUpdate;
  engineLabel: string;
  transcribing: boolean;
  cancelling: boolean;
  onCancel: () => void;
}): ReactElement {
  const activeIdx = STAGES.findIndex((s) => s.matches.includes(progress.stage));
  const percent = Math.max(3, Math.min(100, progress.percent));
  const finished = !transcribing;

  return (
    <div role="status" className="space-y-3 rounded-box bg-hover px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {!finished ? (
          <Spinner className="h-4 w-4 text-primary" />
        ) : progress.stage === "error" || progress.stage === "cancelled" || /cancel/i.test(progress.message) ? (
          <CircleAlert className="h-4 w-4 shrink-0 text-base-content/60" aria-hidden="true" />
        ) : (
          <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        )}
        <p className="min-w-0 flex-1 font-medium">
          {finished ? progress.message || "Transcription finished" : `Transcribing with ${engineLabel}`}
          {!finished && <span className="ml-2 font-normal text-base-content/60">{Math.round(progress.percent)}%</span>}
        </p>
        {transcribing && (
          <button type="button" disabled={cancelling} onClick={onCancel} className="btn btn-ghost btn-sm min-h-11 lg:min-h-0">
            {cancelling ? "Cancelling…" : "Cancel"}
          </button>
        )}
      </div>
      {!finished && (
        <>
          <ol className="flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Transcription stages">
            {STAGES.map((s, idx) => {
              const state = activeIdx < 0 ? "todo" : idx < activeIdx ? "done" : idx === activeIdx ? "active" : "todo";
              return (
                <li key={s.key} className={`flex items-center gap-1.5 ${state === "todo" ? "text-base-content/40" : state === "active" ? "font-medium text-base-content" : "text-base-content/60"}`}>
                  {state === "done" ? (
                    <Check className="h-3 w-3 text-primary" aria-hidden="true" />
                  ) : (
                    <span className={`h-1.5 w-1.5 rounded-full ${state === "active" ? "bg-primary" : "bg-base-content/30"}`} aria-hidden="true" />
                  )}
                  {s.label}
                </li>
              );
            })}
          </ol>
          <progress className="progress progress-primary h-1.5 w-full" value={percent} max={100} aria-label="Transcription progress" />
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-base-content/60">
            <span className="min-w-0 truncate">{progress.message || STAGE_MESSAGES[progress.stage]}</span>
            <span className="flex shrink-0 items-center gap-3 font-mono">
              {progress.current && progress.total ? (
                <span>
                  Segment {progress.current} / {progress.total}
                </span>
              ) : null}
              {progress.currentMs !== undefined && progress.totalMs ? (
                <span>
                  {formatTimeOffset(progress.currentMs)} / {formatTimeOffset(progress.totalMs)}
                </span>
              ) : null}
              {progress.speaker && <span className="font-sans">Speaker: {progress.speaker}</span>}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

export function AudioMissingBanner({
  audioStatus,
  isPlaud,
  canRetry,
  retrying,
  notice,
  onRetry,
  onCheckAgain
}: {
  audioStatus: string;
  isPlaud: boolean;
  canRetry: boolean;
  retrying: boolean;
  notice: string | null;
  onRetry: () => void;
  onCheckAgain: () => void;
}): ReactElement {
  const retrieving = audioStatus === "retrieving";
  return (
    <Banner
      tone={retrieving ? "info" : "error"}
      icon={retrieving ? <Spinner className="h-4 w-4 text-info" /> : <CircleAlert className="h-4 w-4 text-error" aria-hidden="true" />}
      title={retrieving ? "Getting the audio from Plaud…" : "The audio file is missing"}
      actions={
        <>
          {canRetry && (
            <button type="button" disabled={retrying} onClick={onRetry} className="btn btn-sm min-h-11 gap-1.5 lg:min-h-0">
              <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
              {retrying ? "Queueing…" : "Download again"}
            </button>
          )}
          <button type="button" onClick={onCheckAgain} className="btn btn-ghost btn-sm min-h-11 lg:min-h-0">
            Check again
          </button>
        </>
      }
    >
      {retrieving
        ? "This recording is still downloading from Plaud Cloud. Transcription and summaries unlock as soon as it arrives."
        : isPlaud
        ? "The meeting exists but no audio is on disk. Download it again from Plaud Cloud."
        : "No playable audio is attached to this meeting, so it can't be transcribed."}
      {notice && <p className="mt-1 text-xs">{notice}</p>}
    </Banner>
  );
}
