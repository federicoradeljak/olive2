/* Shapes of GET /api/debug/queues (not part of the generated OpenAPI types).
   The human view lives in views/activity/JobsPanel.tsx. */
import type { TranscriptionProgressUpdate } from "../api/types.ts";

export interface DebugQueueJob {
  workflowId: string;
  name: string;
  rawName: string;
  status: string;
  queueName: string | null;
  parentWorkflowId: string | null;
  meetingId: string | null;
  meetingTitle: string | null;
  createdAt: number | null;
  dequeuedAt: number | null;
  completedAt: number | null;
  elapsedMs: number | null;
  waitingMs: number | null;
  queuePosition: number | null;
  deduplicationId: string | null;
  priority: number | null;
  recoveryAttempts: number | null;
  error: string | null;
}

export interface DebugStageQueue {
  name: string;
  workerConcurrency: number;
  activeCount: number;
  waitingCount: number;
  activeJobs: DebugQueueJob[];
  waitingJobs: DebugQueueJob[];
  recentJobs: DebugQueueJob[];
}

export interface DebugStageRun {
  id: string;
  meetingId: string;
  meetingTitle: string | null;
  stage: string;
  status: string;
  jobId: string | null;
  attempts: number;
  startedAt: number | null;
  elapsedMs: number | null;
}

export interface DebugQueuesSnapshot {
  timestamp: number;
  dbosDatabaseUrl: string;
  summary: {
    totalQueues: number;
    totalActiveJobs: number;
    totalWaitingJobs: number;
    activeParentWorkflows: number;
  };
  queues: DebugStageQueue[];
  activeWorkflows: DebugQueueJob[];
  activeTranscriptions: Record<string, TranscriptionProgressUpdate>;
  runningStageRuns: DebugStageRun[];
}

export function formatDurationCompact(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const mins = Math.floor(sec / 60);
  const remSec = Math.round(sec % 60);
  return `${mins}m ${remSec}s`;
}
