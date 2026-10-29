import type { ReactElement, ReactNode } from "react";
import { Download, Merge, RotateCw, Scissors } from "lucide-react";
import type { MeetingUsageResponse } from "../../api/types.ts";
import { MeetingDetailResponse, formatDate } from "../../lib/common";
import { formatUsageUsd } from "../Usage";
import { formatClock, transcriptEngineLabel } from "./transcript";

function Row({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-base-content/55">{label}</dt>
      <dd className="min-w-0 truncate text-right">{children}</dd>
    </div>
  );
}

export function audioFileLabel(mime: string, path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext && ext.length <= 5 && ext !== path.toLowerCase()) return ext;
  return mime.replace(/^audio\//, "");
}

export function DetailsPanel({
  detail,
  usage,
  durationMs,
  canSplit,
  onDownloadAudio,
  onSplit,
  onMerge,
  onRetryAudio,
  onDelete,
  children
}: {
  detail: MeetingDetailResponse;
  usage: MeetingUsageResponse | null;
  durationMs: number | null;
  canSplit: boolean;
  onDownloadAudio: (() => void) | null;
  onSplit: () => void;
  onMerge: () => void;
  onRetryAudio: (() => void) | null;
  onDelete: () => void;
  children?: ReactNode;
}): ReactElement {
  const recording = detail.recordings[0];
  const transcriptArtifact =
    detail.artifacts.find((a) => a.id === detail.meeting.primaryTranscriptArtifactId) ??
    detail.artifacts.filter((a) => a.kind === "transcript").sort((a, b) => b.createdAt - a.createdAt)[0];
  const engine = transcriptEngineLabel(transcriptArtifact?.provider);
  const hasUsage = !!usage && usage.eventCount > 0;
  const actionClass = "flex min-h-11 w-full items-center gap-2.5 rounded-md px-2 text-left text-sm hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-9";

  return (
    <div className="space-y-6 px-4 py-4 lg:px-5">
      <h2 className="font-semibold">Details</h2>
      {children}
      <dl className="space-y-2 text-[13px]">
        {recording ? (
          <Row label="Audio">
            {audioFileLabel(recording.mime, recording.path)} · {(recording.sizeBytes / 1024 / 1024).toFixed(1)} MB
            {durationMs ? ` · ${formatClock(durationMs)}` : ""}
          </Row>
        ) : (
          <Row label="Audio">None yet</Row>
        )}
        <Row label="Transcribed with">{engine ?? "Not transcribed"}</Row>
        {hasUsage ? (
          <>
            <Row label="Transcription cost">{usage.transcriptionCostUsd > 0 ? formatUsageUsd(usage.transcriptionCostUsd) : "Free"}</Row>
            <Row label="AI cost">{usage.llmCostUsd > 0 ? formatUsageUsd(usage.llmCostUsd) : "Free"}</Row>
            <Row label="Total">≈ {formatUsageUsd(usage.totalCostUsd)}</Row>
          </>
        ) : (
          <Row label="Cost">Free</Row>
        )}
        <Row label="Imported">{formatDate(detail.meeting.createdAt)}</Row>
        <Row label="Last updated">{formatDate(detail.meeting.updatedAt)}</Row>
      </dl>
      {detail.meeting.status === "error" && detail.meeting.lastError && (
        <p className="rounded-lg bg-error/10 px-3 py-2 text-xs">
          <span className="font-medium">Last error:</span> {detail.meeting.lastError}
        </p>
      )}

      <div className="space-y-0.5">
        {onDownloadAudio && (
          <button type="button" onClick={onDownloadAudio} className={actionClass}>
            <Download className="h-4 w-4 text-base-content/55" aria-hidden="true" /> Download audio
          </button>
        )}
        {onRetryAudio && (
          <button type="button" onClick={onRetryAudio} className={actionClass}>
            <RotateCw className="h-4 w-4 text-base-content/55" aria-hidden="true" /> Download audio again from Plaud
          </button>
        )}
        <button type="button" onClick={onSplit} disabled={!canSplit} className={actionClass} title={canSplit ? undefined : "Needs at least 15 seconds of audio"}>
          <Scissors className="h-4 w-4 text-base-content/55" aria-hidden="true" /> Split meeting at playhead…
        </button>
        <button type="button" onClick={onMerge} className={actionClass}>
          <Merge className="h-4 w-4 text-base-content/55" aria-hidden="true" /> Merge with another meeting…
        </button>
      </div>

      <div className="space-y-2.5 rounded-lg border border-error/25 p-3">
        <p className="text-[13px] text-base-content/60">Deleting removes the recording, transcripts, summaries and chat. This can't be undone.</p>
        <button type="button" onClick={onDelete} className="btn btn-sm min-h-11 border-error/60 bg-transparent font-medium text-error hover:bg-error/10 lg:min-h-0">
          Delete meeting…
        </button>
      </div>
    </div>
  );
}
