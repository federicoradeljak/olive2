import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { ChevronLeft, CircleAlert, ClipboardCopy, Download, Ellipsis, FileText, Info, Merge, Pencil, RotateCw, Scissors, Sparkles, Square, Trash2, Users, Wand2, X } from "lucide-react";
import { confirmAction, notify } from "../components/ui";
import type { MeetingListItem, MeetingUsageResponse, SummaryGenerationStatus, SpeakerReidentificationStatus, TranscriptionProgressUpdate } from "../api/types.ts";
import { MeetingDetailResponse, SpeakerWithStats } from "../lib/common";
import { ChatTitleReporter, MeetingChatInline } from "./MeetingChat";
import {
  GenerateSummaryModal,
  MergeMeetingModal,
  RapidEnrollModal,
  ReassignSpeakerModal,
  SPLIT_EDGE_MS,
  SplitMeetingModal,
  SplitSegmentModal,
  TranscribeModal,
  type TranscribeOptions
} from "./meetingModals";
import { Menu, Segmented, Spinner, downloadText, navigateTo, safeFilename, useMediaQuery, type MenuEntry } from "./meeting/kit";
import { languageName, parseTranscript, speakerStats, transcriptToMarkdown, transcriptToText, turnIndexAt, type TranscriptTurn } from "./meeting/transcript";
import { AudioMissingBanner, Banner, TranscriptionBanner } from "./meeting/Banners";
import { MeetingTitle, PropertyChips, PropertyList } from "./meeting/Properties";
import { SummaryTab, copySummary, downloadSummary, useModelNames } from "./meeting/SummaryTab";
import { TranscriptTab, type TurnActions } from "./meeting/TranscriptTab";
import { SpeakersPanel } from "./meeting/SpeakersPanel";
import { DetailsPanel, audioFileLabel } from "./meeting/DetailsPanel";
import { PlayerBar } from "./meeting/PlayerBar";

type Panel = "chat" | "speakers" | "details";
type DocTab = "summary" | "transcript";
type MobileTab = DocTab | "chat";

const PANEL_STORAGE_KEY = "olive.meetingPanel";

function readStoredPanel(): Panel | null {
  try {
    const v = window.localStorage.getItem(PANEL_STORAGE_KEY);
    if (v === "none") return null;
    if (v === "chat" || v === "speakers" || v === "details") return v;
  } catch {
    // storage unavailable: fall back to the default
  }
  return "chat";
}

function engineDisplayName(engine: string, modalAsrModel: string): string {
  if (engine.startsWith("local")) return "the local pipeline";
  if (engine === "assemblyai") return "AssemblyAI";
  if (engine === "muse") return "Muse Voice";
  if (engine === "modal") return `Modal GPU (${modalAsrModel})`;
  return "Speechmatics";
}

export function MeetingDetailView({
  meetingId,
  knownSpeakers,
  onBack,
  onDeleted,
  onSpeakerUpdated,
  onChatTitle
}: {
  meetingId: string;
  knownSpeakers: SpeakerWithStats[];
  onBack: () => void;
  onDeleted: () => void;
  onSpeakerUpdated: () => void;
  /** Kept for App compatibility; chat now lives in the page's side panel. */
  onChatOpenChange: (open: boolean) => void;
  onChatTitle: (title: string) => void;
}): ReactElement {
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const modelNames = useModelNames();

  const [detail, setDetail] = useState<MeetingDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [cancellingTranscription, setCancellingTranscription] = useState(false);
  const [transcriptionProgress, setTranscriptionProgress] = useState<TranscriptionProgressUpdate | null>(null);
  const transcriptionAbortRef = useRef<AbortController | null>(null);
  const [transcribeOptions, setTranscribeOptions] = useState<TranscribeOptions>({
    engine: "local:cohere",
    language: "",
    modalAsrModel: "cohere",
    clusteringThreshold: 0.5,
    similarityThreshold: 0.45
  });
  const [showTranscribeModal, setShowTranscribeModal] = useState(false);
  const [enhancedAudio, setEnhancedAudio] = useState(true);
  const [reassigningSpeaker, setReassigningSpeaker] = useState<{ speaker: string; segmentIndex?: number } | null>(null);
  const [reidentifyingSpeakers, setReidentifyingSpeakers] = useState(false);
  const [reidentifyStatus, setReidentifyStatus] = useState<SpeakerReidentificationStatus | null>(null);
  const [showRapidEnroll, setShowRapidEnroll] = useState(false);
  const [splittingSegment, setSplittingSegment] = useState<TranscriptTurn | null>(null);
  const [showSummaryModal, setShowSummaryModal] = useState(false);
  const [selectedSummaryId, setSelectedSummaryId] = useState<string | null>(null);
  const [summaryGeneration, setSummaryGeneration] = useState<SummaryGenerationStatus | null>(null);
  const [playingSegmentIndex, setPlayingSegmentIndex] = useState<number | null>(null);
  const playbackStopMsRef = useRef<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [audioEl, setAudioEl] = useState<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [activeTurnIdx, setActiveTurnIdx] = useState<number | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [autoTitling, setAutoTitling] = useState(false);
  const [savingTags, setSavingTags] = useState(false);
  const [retryingAudio, setRetryingAudio] = useState(false);
  const [audioRetryNotice, setAudioRetryNotice] = useState<string | null>(null);
  const [audioDurationMs, setAudioDurationMs] = useState<number | null>(null);
  const [splitModal, setSplitModal] = useState<{ initialMs: number | null } | null>(null);
  const [splittingMeeting, setSplittingMeeting] = useState(false);
  const [splitResult, setSplitResult] = useState<{ newMeetingId: string; newTitle: string } | null>(null);
  const [showMergeModal, setShowMergeModal] = useState(false);
  const [usage, setUsage] = useState<MeetingUsageResponse | null>(null);
  const [tab, setTab] = useState<MobileTab | null>(null);
  const [panel, setPanel] = useState<Panel | null>(readStoredPanel);
  const [sheet, setSheet] = useState<"speakers" | "details" | null>(null);
  const mobileTabsAnchorRef = useRef<HTMLDivElement | null>(null);

  const setAudioRef = useCallback((el: HTMLAudioElement | null) => {
    audioRef.current = el;
    setAudioEl(el);
  }, []);

  const audioStatus = detail?.meeting.audioStatus ?? (detail && detail.recordings.length === 0 ? "retrieving" : "ready");
  const hasNoAudio = !!detail && audioStatus !== "ready";

  const parsed = useMemo(() => parseTranscript(detail?.transcriptContent), [detail?.transcriptContent]);
  const turns = parsed.turns;
  const stats = useMemo(() => speakerStats(turns), [turns]);
  const languageLabel = languageName(parsed.language);

  const summaries = detail?.summaries || [];
  const activeSummary =
    summaries.find((s) => s.id === selectedSummaryId) ||
    summaries.find((s) => s.isPrimary) ||
    summaries[0] ||
    null;

  const defaultTab: DocTab = summaries.length > 0 ? "summary" : "transcript";
  const docTab: DocTab = tab === "summary" || tab === "transcript" ? tab : defaultTab;
  const mobileTab: MobileTab = tab ?? defaultTab;

  const durationMs =
    audioDurationMs ??
    detail?.recordings[0]?.durationMs ??
    (detail ? Math.max(0, detail.meeting.endTime - detail.meeting.startTime) || null : null);
  const splitTotalMs = audioDurationMs ?? detail?.recordings[0]?.durationMs ?? null;
  const canSplit = splitTotalMs !== null && splitTotalMs > 15000;
  const splitAllowedAt = (ms: number) =>
    splitTotalMs === null || (ms >= SPLIT_EDGE_MS && ms <= splitTotalMs - SPLIT_EDGE_MS);

  const summaryGenerating = summaryGeneration?.stage === "running";
  const hasTranscript = turns.length > 0 || !!detail?.transcriptContent;

  /* ---------------------------------------------------------------- */
  /* Data loading                                                      */
  /* ---------------------------------------------------------------- */

  const fetchDetail = async () => {
    try {
      const res = await fetch(`/api/meetings/${meetingId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as MeetingDetailResponse;
      setDetail(data);
      if (data.summaryGeneration?.stage === "running") {
        setSummaryGeneration(data.summaryGeneration);
      }
      if (data.speakerReidentification) {
        const stage = data.speakerReidentification.stage;
        setReidentifyStatus(data.speakerReidentification);
        setReidentifyingSpeakers(stage === "queued" || stage === "running");
      }
      if (data.transcriptionProgress) {
        const stage = data.transcriptionProgress.stage;
        if (stage === "done" || stage === "error" || stage === "cancelled") {
          // Terminal state (e.g. just-cancelled): not active work. Clearing
          // here keeps a cancel from flipping back to in-progress when the
          // detail refresh lands after the optimistic cancelled UI.
          setTranscriptionProgress(null);
          setTranscribing(false);
        } else {
          setTranscriptionProgress(data.transcriptionProgress);
          setTranscribing(true);
        }
      } else if (data.meeting?.status === "processing") {
        setTranscribing(true);
      } else if (data.meeting?.status === "ready") {
        setTranscribing(false);
      }
      if (data.summaries && data.summaries.length > 0) {
        const primary = data.summaries.find((s) => s.isPrimary);
        setSelectedSummaryId((prev) => prev || primary?.id || data.summaries[0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load meeting");
    } finally {
      setLoading(false);
    }
  };

  // Transcription defaults (engine, thresholds) come from the app config.
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/config")
      .then((res) => (res.ok ? res.json() : null))
      .then((cfg) => {
        if (cancelled || !cfg) return;
        setTranscribeOptions((prev) => ({
          ...prev,
          engine:
            cfg.transcriptionProvider === "speechmatics" || cfg.transcriptionProvider === "assemblyai" || cfg.transcriptionProvider === "muse" || cfg.transcriptionProvider === "modal"
              ? cfg.transcriptionProvider
              : "local:cohere",
          modalAsrModel: cfg.modalAsrModel || prev.modalAsrModel,
          clusteringThreshold: cfg.localClusteringThreshold ?? prev.clusteringThreshold,
          similarityThreshold: cfg.localSimilarityThreshold ?? prev.similarityThreshold
        }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void fetchDetail();

    let eventSource: EventSource | null = null;
    let isClosed = false;

    try {
      eventSource = new EventSource(`/api/meetings/${meetingId}/transcribe/progress?stream=true`);

      eventSource.addEventListener("progress", (e) => {
        if (isClosed) return;
        try {
          const data = JSON.parse(e.data);
          if (data && (data.stage === "done" || data.stage === "error" || data.stage === "cancelled")) {
            // Mislabeled terminal state (e.g. a snapshot taken right after
            // cancel): never treat it as active work.
            return;
          }
          setTranscriptionProgress(data);
          setTranscribing(true);
        } catch {}
      });

      eventSource.addEventListener("result", (e) => {
        if (isClosed) return;
        try {
          const data = JSON.parse(e.data);
          setTranscriptionProgress({ ...data, message: data?.message || "Transcription finished" });
        } catch {}
        setTranscribing(false);
        void fetchDetail();
        setTimeout(() => {
          if (!isClosed) setTranscriptionProgress(null);
        }, 3500);
      });

      eventSource.addEventListener("cancelled", () => {
        if (isClosed) return;
        setTranscriptionProgress({
          stage: "done",
          percent: 0,
          message: "Transcription was cancelled."
        });
        setTranscribing(false);
        void fetchDetail();
        setTimeout(() => {
          if (!isClosed) setTranscriptionProgress(null);
        }, 2500);
      });

      eventSource.addEventListener("error", (e) => {
        if (isClosed) return;
        if (e instanceof MessageEvent && e.data) {
          try {
            const data = JSON.parse(e.data);
            setError(data.error || data.message || "Transcription failed");
          } catch {}
          setTranscribing(false);
          setTimeout(() => {
            if (!isClosed) setTranscriptionProgress(null);
          }, 3500);
        }
      });
    } catch (err) {
      console.warn("Could not connect to SSE progress stream:", err);
    }

    return () => {
      isClosed = true;
      if (eventSource) {
        eventSource.close();
      }
    };
  }, [meetingId]);

  useEffect(() => {
    if (!summaryGenerating) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch(`/api/meetings/${meetingId}/summarize/status`);
        if (!res.ok) return;
        const data = (await res.json()) as { generating: boolean; status: SummaryGenerationStatus | null };
        if (cancelled) return;

        if (!data.status) {
          // Lost track of the job (e.g. server restart) — stop waiting
          setSummaryGeneration(null);
          return;
        }
        if (data.status.stage === "running") return;

        if (data.status.stage === "done") {
          setSummaryGeneration(null);
          if (data.status.artifactId) {
            setSelectedSummaryId(data.status.artifactId);
          }
          await fetchDetail();
        } else {
          setSummaryGeneration(data.status);
          setTimeout(() => {
            if (!cancelled) setSummaryGeneration(null);
          }, 8000);
        }
      } catch {
        // transient network error — keep polling
      }
    };

    const interval = setInterval(() => void poll(), 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [summaryGenerating, meetingId]);

  // Cost estimate: refresh when summaries or the transcript change.
  const usageKey = `${summaries.length}:${detail?.meeting.primaryTranscriptArtifactId ?? ""}:${detail?.meeting.updatedAt ?? 0}`;
  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/meetings/${meetingId}/usage`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: MeetingUsageResponse | null) => {
        if (!cancelled) setUsage(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [meetingId, usageKey]);

  /* ---------------------------------------------------------------- */
  /* Meeting edits                                                     */
  /* ---------------------------------------------------------------- */

  const saveTitle = async (title: string): Promise<boolean> => {
    try {
      const res = await fetch(`/api/meetings/${meetingId}/title`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title })
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; meeting?: MeetingListItem };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (!data.meeting) throw new Error("Meeting title update returned no meeting");
      setDetail((prev) => (prev ? { ...prev, meeting: { ...prev.meeting, title: data.meeting!.title } } : prev));
      return true;
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Failed to rename meeting");
      return false;
    }
  };

  const saveStartTime = async (ms: number): Promise<boolean> => {
    try {
      const res = await fetch(`/api/meetings/${meetingId}/start-time`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startTime: ms })
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; meeting?: MeetingListItem };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (!data.meeting) throw new Error("Meeting time update returned no meeting");
      setDetail((prev) =>
        prev ? { ...prev, meeting: { ...prev.meeting, startTime: data.meeting!.startTime, endTime: data.meeting!.endTime } } : prev
      );
      return true;
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Failed to update meeting time");
      return false;
    }
  };

  const handleAutoTitle = async () => {
    if (autoTitling || editingTitle) return;
    setAutoTitling(true);
    try {
      const res = await fetch(`/api/meetings/${meetingId}/auto-title`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; meeting?: MeetingListItem };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (!data.meeting) throw new Error("Auto-title returned no meeting");
      setDetail((prev) => (prev ? { ...prev, meeting: { ...prev.meeting, title: data.meeting!.title } } : prev));
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Failed to suggest a title");
    } finally {
      setAutoTitling(false);
    }
  };

  const saveTags = async (nextTags: string[]) => {
    setSavingTags(true);
    try {
      const res = await fetch(`/api/meetings/${meetingId}/tags`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags: nextTags })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { meeting: MeetingListItem };
      setDetail((prev) => (prev ? { ...prev, meeting: { ...prev.meeting, tags: data.meeting.tags } } : prev));
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Failed to update tags");
    } finally {
      setSavingTags(false);
    }
  };

  const handleRetryAudio = async () => {
    if (retryingAudio) return;
    setRetryingAudio(true);
    setAudioRetryNotice(null);
    try {
      const res = await fetch(`/api/meetings/${meetingId}/audio/retry`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setAudioRetryNotice("Download queued — the audio appears here automatically once Plaud Cloud serves it.");
      await fetchDetail();
    } catch (err) {
      setAudioRetryNotice(err instanceof Error ? err.message : "Failed to queue audio download");
    } finally {
      setRetryingAudio(false);
    }
  };

  const confirmSplitMeeting = async (splitMs: number) => {
    if (splittingMeeting) return;
    setSplittingMeeting(true);
    try {
      const res = await fetch(`/api/meetings/${meetingId}/split`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ splitMs })
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        newMeeting?: { id: string; title: string };
      };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (!data.newMeeting) throw new Error("Split returned no new meeting");
      setSplitModal(null);
      setSplitResult({ newMeetingId: data.newMeeting.id, newTitle: data.newMeeting.title });
      await fetchDetail();
      // The audio file changed on disk: drop the cached duration (which
      // otherwise keeps splitTotalMs pinned to the pre-split length) and
      // force the <audio> element to re-request instead of replaying its
      // buffered/stale source.
      setAudioDurationMs(null);
      if (audioRef.current) audioRef.current.load();
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Failed to split meeting");
    } finally {
      setSplittingMeeting(false);
    }
  };

  const handleDeleteMeeting = async () => {
    if (!detail) return;
    if (
      !(await confirmAction({
        title: "Delete meeting",
        message: `Delete “${detail.meeting.title}”? Its recording, transcripts, summaries and chat are removed permanently. This can't be undone.`,
        confirmLabel: "Delete meeting",
        danger: true
      }))
    ) {
      return;
    }
    try {
      const res = await fetch(`/api/meetings/${meetingId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `Failed to delete meeting (HTTP ${res.status})`);
      }
      onDeleted();
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    }
  };

  const downloadAudio = () => {
    const rec = detail?.recordings[0];
    if (!detail || !rec) return;
    const a = document.createElement("a");
    a.href = `/api/meetings/${meetingId}/audio`;
    a.download = `${safeFilename(detail.meeting.title)}.${audioFileLabel(rec.mime, rec.path)}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  /* ---------------------------------------------------------------- */
  /* Transcription                                                     */
  /* ---------------------------------------------------------------- */

  const handleCancelTranscription = async () => {
    setCancellingTranscription(true);
    if (transcriptionAbortRef.current) {
      try {
        transcriptionAbortRef.current.abort();
      } catch {}
      transcriptionAbortRef.current = null;
    }

    setTranscriptionProgress({
      stage: "done",
      percent: 0,
      message: "Cancelling transcription..."
    });

    try {
      await fetch(`/api/meetings/${meetingId}/transcribe/cancel`, { method: "POST" });
    } catch (err) {
      console.warn("Failed to call cancel API:", err);
    } finally {
      setTranscribing(false);
      setCancellingTranscription(false);
      await fetchDetail();
      setTimeout(() => setTranscriptionProgress(null), 2500);
    }
  };

  const handleTriggerTranscription = async () => {
    setShowTranscribeModal(false);
    if (hasNoAudio) {
      setError(
        audioStatus === "retrieving"
          ? "The audio is still being fetched from Plaud Cloud — transcription unlocks once it arrives."
          : "No audio file is attached to this meeting — transcription needs audio first."
      );
      return;
    }
    setTranscribing(true);
    setCancellingTranscription(false);
    const abortController = new AbortController();
    transcriptionAbortRef.current = abortController;

    setTranscriptionProgress({
      stage: "decoding",
      percent: 3,
      message: "Starting transcription…"
    });

    const { engine, language, modalAsrModel, clusteringThreshold, similarityThreshold } = transcribeOptions;
    const isLocal = engine.startsWith("local");
    const modelId = "onnx-community/cohere-transcribe-03-2026-ONNX";

    try {
      const res = await fetch(`/api/meetings/${meetingId}/transcribe`, {
        method: "POST",
        signal: abortController.signal,
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          background: true,
          provider: isLocal ? "local" : engine,
          modelId: isLocal ? modelId : undefined,
          poll: true,
          force: true,
          clusteringThreshold: isLocal ? clusteringThreshold : undefined,
          similarityThreshold: isLocal ? similarityThreshold : undefined,
          asrModel: engine === "modal" ? modalAsrModel : undefined,
          language: language || undefined
        })
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
    } catch (err: any) {
      if (abortController.signal.aborted || err?.name === "AbortError") {
        return;
      }
      setTranscribing(false);
      setTranscriptionProgress(null);
      notify("error", `Transcription error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      transcriptionAbortRef.current = null;
    }
  };

  /* ---------------------------------------------------------------- */
  /* Summaries                                                         */
  /* ---------------------------------------------------------------- */

  const handleSetPrimarySummary = async (artifactId: string) => {
    try {
      const res = await fetch(`/api/meetings/${meetingId}/summaries/${artifactId}/primary`, {
        method: "POST"
      });
      if (!res.ok) throw new Error("Failed to set primary summary");
      await fetchDetail();
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    }
  };

  const handleDeleteSummary = async (artifactId: string) => {
    if (!(await confirmAction({ title: "Delete summary version", message: "Delete this summary version? This can't be undone.", confirmLabel: "Delete", danger: true }))) {
      return;
    }
    try {
      const res = await fetch(`/api/meetings/${meetingId}/summaries/${artifactId}`, {
        method: "DELETE"
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `Failed to delete summary (HTTP ${res.status})`);
      }
      setSelectedSummaryId(null);
      await fetchDetail();
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    }
  };

  /* ---------------------------------------------------------------- */
  /* Speakers                                                          */
  /* ---------------------------------------------------------------- */

  const handleReidentifySpeakers = async () => {
    if (!detail || reidentifyingSpeakers) return;
    setReidentifyingSpeakers(true);
    try {
      const res = await fetch(`/api/meetings/${meetingId}/speakers/reidentify`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      // Poll the tracked job status (queued -> running -> done/error) just
      // like transcription progress and summary generation — no updatedAt
      // guessing.
      const deadline = Date.now() + 5 * 60 * 1000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const poll = await fetch(`/api/meetings/${meetingId}/speakers/reidentify/status`);
          if (poll.ok) {
            const body = (await poll.json()) as { status: SpeakerReidentificationStatus | null };
            if (body.status) setReidentifyStatus(body.status);
            const stage = body.status?.stage;
            if (stage === "done" || stage === "error" || stage === "cancelled") break;
          }
        } catch {}
        if (Date.now() > deadline) break;
      }
      await fetchDetail();
      onSpeakerUpdated();
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Failed to re-identify speakers");
    } finally {
      setReidentifyingSpeakers(false);
    }
  };

  const handleConfirmSegment = async (segmentIndex: number) => {
    try {
      const res = await fetch(`/api/meetings/${meetingId}/speakers/confirm-segment`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ segmentIndex })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = (await res.json().catch(() => ({}))) as {
        voiceprintStatus?: string;
        statusReason?: string;
        speaker?: { name: string };
      };
      const name = data.speaker?.name || "speaker";
      const notes: Record<string, string> = {
        enrolled: `Confirmed ${name} and learned from this clip`,
        enrolled_evicted: `Confirmed ${name} (voice samples full: replaced the oldest one)`,
        redundant_skipped: `Confirmed ${name} (voice already well known — clip not needed)`,
        outlier_rejected: `Confirmed ${name} (clip too noisy or different to learn from)`,
        duration_skipped: `Confirmed ${name} (clip under 3s — too short to learn from)`
      };
      notify("success", notes[data.voiceprintStatus ?? ""] ?? `Confirmed ${name}`);

      await fetchDetail();
      onSpeakerUpdated();
    } catch (err) {
      notify("error", `Failed to confirm speaker: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleUnassignSegment = async (segmentIndex: number) => {
    try {
      const res = await fetch(`/api/meetings/${meetingId}/speakers/unassign-segment`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ segmentIndex })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      await fetchDetail();
      onSpeakerUpdated();
    } catch (err) {
      notify("error", `Failed to unassign speaker: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleMergeWithNext = async (segmentIndex: number) => {
    try {
      const res = await fetch(`/api/meetings/${meetingId}/speakers/merge-segments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ segmentIndex })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      await fetchDetail();
      onSpeakerUpdated();
    } catch (err) {
      notify("error", `Failed to merge turns: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /* ---------------------------------------------------------------- */
  /* Audio                                                             */
  /* ---------------------------------------------------------------- */

  /** Play one turn or clip and stop at its end; toggles pause when repeated. */
  const handlePlaySegment = (seg: { startMs: number; endMs: number }, idx: number) => {
    if (!audioRef.current) return;

    if (playingSegmentIndex === idx && !audioRef.current.paused) {
      audioRef.current.pause();
      setPlayingSegmentIndex(null);
      playbackStopMsRef.current = null;
      return;
    }

    audioRef.current.currentTime = seg.startMs / 1000;
    playbackStopMsRef.current = seg.endMs;
    setPlayingSegmentIndex(idx);
    void audioRef.current.play();
  };

  /** Seek and keep playing from there. */
  const seekTo = (ms: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    playbackStopMsRef.current = null;
    setPlayingSegmentIndex(null);
    audio.currentTime = ms / 1000;
    setActiveTurnIdx(turnIndexAt(turns, ms));
    void audio.play();
  };

  const toggleEnhanced = () => {
    const currentTime = audioRef.current?.currentTime || 0;
    const wasPlaying = !audioRef.current?.paused;
    setEnhancedAudio((v) => !v);
    setTimeout(() => {
      if (audioRef.current) {
        audioRef.current.currentTime = currentTime;
        if (wasPlaying) void audioRef.current.play();
      }
    }, 50);
  };

  const playheadMs = (): number | null => {
    const secs = audioRef.current?.currentTime;
    return secs !== undefined && Number.isFinite(secs) && secs > 0 ? Math.round(secs * 1000) : null;
  };

  /* ---------------------------------------------------------------- */
  /* Panels and menus                                                  */
  /* ---------------------------------------------------------------- */

  const togglePanel = (p: Panel) => {
    const next = panel === p ? null : p;
    setPanel(next);
    try {
      window.localStorage.setItem(PANEL_STORAGE_KEY, next ?? "none");
    } catch {
      // per-viewer convenience only
    }
  };

  const openSpeakers = () => {
    if (isDesktop) {
      if (panel !== "speakers") togglePanel("speakers");
    } else {
      setSheet("speakers");
    }
  };

  const copyTranscript = async () => {
    try {
      await navigator.clipboard.writeText(transcriptToText(turns));
      notify("success", "Transcript copied");
    } catch {
      notify("error", "Couldn't copy to the clipboard");
    }
  };

  const exportTranscript = (format: "txt" | "md") => {
    if (!detail) return;
    const name = safeFilename(detail.meeting.title);
    if (turns.length === 0) {
      downloadText(`${name}.txt`, detail.transcriptContent ?? "");
    } else if (format === "md") {
      downloadText(`${name} - transcript.md`, transcriptToMarkdown(detail.meeting.title, turns), "text/markdown");
    } else {
      downloadText(`${name} - transcript.txt`, transcriptToText(turns));
    }
  };

  const turnActions: TurnActions = {
    onSeek: seekTo,
    onPlayTurnOnly: (turn, idx) => handlePlaySegment(turn, idx),
    onConfirm: (segmentIndex) => void handleConfirmSegment(segmentIndex),
    onChange: (turn) => setReassigningSpeaker({ speaker: turn.speaker, segmentIndex: turn.segmentIndex }),
    onSplitTurn: (turn) => setSplittingSegment(turn),
    onMerge: (segmentIndex) => void handleMergeWithNext(segmentIndex),
    onUnassign: (segmentIndex) => void handleUnassignSegment(segmentIndex),
    onSplitMeetingHere: (ms) => setSplitModal({ initialMs: ms }),
    splitAllowedAt
  };

  if (!detail) {
    return (
      <div className="px-0 py-4 lg:px-14 lg:py-10">
        <button type="button" onClick={onBack} className="btn btn-ghost btn-sm -ml-2 min-h-11 gap-1 font-normal text-base-content/60 lg:min-h-0">
          <ChevronLeft className="h-4 w-4" aria-hidden="true" /> Meetings
        </button>
        <div className="mt-6">
          {loading ? (
            <p className="flex items-center gap-2 text-sm text-base-content/60">
              <Spinner /> Loading meeting…
            </p>
          ) : (
            <Banner tone="error" icon={<CircleAlert className="h-4 w-4 text-error" aria-hidden="true" />} title="This meeting couldn't be loaded">
              {error}
            </Banner>
          )}
        </div>
      </div>
    );
  }

  const meeting = detail.meeting;
  const hasAudioFile = detail.recordings.length > 0;
  const needsReview = stats.filter((s) => s.status !== "verified").length;

  const moreItems: MenuEntry[] = [
    { key: "suggest", icon: <Sparkles className="h-4 w-4" aria-hidden="true" />, label: "Suggest title", disabled: autoTitling, onSelect: () => void handleAutoTitle() },
    { key: "rename", icon: <Pencil className="h-4 w-4" aria-hidden="true" />, label: "Rename", onSelect: () => setEditingTitle(true) },
    "divider",
    transcribing
      ? { key: "cancel", icon: <Square className="h-4 w-4" aria-hidden="true" />, label: "Cancel transcription", disabled: cancellingTranscription, onSelect: () => void handleCancelTranscription() }
      : {
          key: "transcribe",
          icon: <RotateCw className="h-4 w-4" aria-hidden="true" />,
          label: hasTranscript ? "Re-transcribe…" : "Transcribe…",
          disabled: hasNoAudio,
          onSelect: () => setShowTranscribeModal(true)
        },
    { key: "summary", icon: <FileText className="h-4 w-4" aria-hidden="true" />, label: "New summary…", disabled: summaryGenerating || hasNoAudio, onSelect: () => setShowSummaryModal(true) },
    turns.length > 0 && { key: "identify", icon: <Wand2 className="h-4 w-4" aria-hidden="true" />, label: "Identify voices…", onSelect: () => setShowRapidEnroll(true) },
    turns.length > 0 && {
      key: "reidentify",
      icon: <Users className="h-4 w-4" aria-hidden="true" />,
      label: reidentifyingSpeakers ? "Re-identifying speakers…" : "Re-identify speakers",
      disabled: reidentifyingSpeakers,
      onSelect: () => void handleReidentifySpeakers()
    },
    "divider",
    hasTranscript && { key: "export", icon: <Download className="h-4 w-4" aria-hidden="true" />, label: "Export transcript (.txt)", onSelect: () => exportTranscript("txt") },
    hasAudioFile && { key: "audio", icon: <Download className="h-4 w-4" aria-hidden="true" />, label: "Download audio", onSelect: downloadAudio },
    canSplit && { key: "split", icon: <Scissors className="h-4 w-4" aria-hidden="true" />, label: "Split meeting…", onSelect: () => setSplitModal({ initialMs: playheadMs() }) },
    { key: "merge", icon: <Merge className="h-4 w-4" aria-hidden="true" />, label: "Merge with another meeting…", onSelect: () => setShowMergeModal(true) },
    !isDesktop && "divider",
    !isDesktop && { key: "speakers", icon: <Users className="h-4 w-4" aria-hidden="true" />, label: "Speakers", onSelect: () => setSheet("speakers") },
    !isDesktop && { key: "details", icon: <Info className="h-4 w-4" aria-hidden="true" />, label: "Details", onSelect: () => setSheet("details") },
    !isDesktop && hasAudioFile && { key: "enhanced", icon: <Sparkles className="h-4 w-4" aria-hidden="true" />, label: "Enhanced voice", checked: enhancedAudio, onSelect: toggleEnhanced },
    "divider",
    { key: "delete", icon: <Trash2 className="h-4 w-4" aria-hidden="true" />, label: "Delete meeting…", danger: true, onSelect: () => void handleDeleteMeeting() }
  ];

  const moreMenu = (
    <Menu
      ariaLabel="More actions"
      triggerClassName={`btn btn-ghost btn-square ${isDesktop ? "btn-sm text-base-content/60" : "h-11 w-11"}`}
      trigger={<Ellipsis className={isDesktop ? "h-4 w-4" : "h-5 w-5"} aria-hidden="true" />}
      items={moreItems}
      menuClassName="min-w-[260px]"
    />
  );

  /* ---------------------------------------------------------------- */
  /* Sections                                                          */
  /* ---------------------------------------------------------------- */

  const transcribeButton = transcribing ? (
    <button type="button" disabled className="btn btn-sm min-h-11 gap-2 lg:min-h-0">
      <Spinner className="h-3.5 w-3.5" /> Transcribing…
    </button>
  ) : (
    <button
      type="button"
      onClick={() => setShowTranscribeModal(true)}
      disabled={hasNoAudio}
      title={hasNoAudio ? "Transcription unlocks once the meeting audio is attached" : undefined}
      className={`btn btn-sm min-h-11 lg:min-h-0 ${hasTranscript ? "border-base-300 bg-transparent" : "btn-primary"}`}
    >
      {hasTranscript ? "Re-transcribe…" : "Transcribe"}
    </button>
  );

  const tabActions =
    docTab === "summary" ? (
      <>
        {activeSummary && (
          <Menu
            ariaLabel="Export summary"
            triggerClassName="btn btn-sm min-h-11 border-base-300 bg-transparent font-normal lg:min-h-0"
            trigger="Export"
            items={[
              {
                key: "copy",
                icon: <ClipboardCopy className="h-4 w-4" aria-hidden="true" />,
                label: "Copy markdown",
                onSelect: () => void copySummary(activeSummary.content).then((ok) => notify(ok ? "success" : "error", ok ? "Summary copied" : "Couldn't copy to the clipboard"))
              },
              { key: "md", icon: <Download className="h-4 w-4" aria-hidden="true" />, label: "Download .md", onSelect: () => downloadSummary(meeting.title, activeSummary) }
            ]}
          />
        )}
        <button
          type="button"
          onClick={() => setShowSummaryModal(true)}
          disabled={summaryGenerating || hasNoAudio}
          title={hasNoAudio ? "Summaries need meeting audio first" : summaryGenerating ? "A summary is already being written" : undefined}
          className="btn btn-primary btn-sm min-h-11 lg:min-h-0"
        >
          New summary
        </button>
      </>
    ) : (
      <>
        {hasTranscript && (
          <Menu
            ariaLabel="Export transcript"
            triggerClassName="btn btn-sm min-h-11 border-base-300 bg-transparent font-normal lg:min-h-0"
            trigger="Export"
            items={[
              { key: "copy", icon: <ClipboardCopy className="h-4 w-4" aria-hidden="true" />, label: "Copy transcript", onSelect: () => void copyTranscript() },
              { key: "txt", icon: <Download className="h-4 w-4" aria-hidden="true" />, label: "Download .txt", onSelect: () => exportTranscript("txt") },
              turns.length > 0 && { key: "md", icon: <Download className="h-4 w-4" aria-hidden="true" />, label: "Download .md", onSelect: () => exportTranscript("md") }
            ]}
          />
        )}
        {transcribeButton}
      </>
    );

  const banners = (
    <div className="space-y-2.5 empty:hidden">
      {error && (
        <Banner tone="error" icon={<CircleAlert className="h-4 w-4 text-error" aria-hidden="true" />} title="Something went wrong" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      )}
      {hasNoAudio && (
        <AudioMissingBanner
          audioStatus={audioStatus}
          isPlaud={meeting.source === "plaud"}
          canRetry={!!meeting.canRetryAudio}
          retrying={retryingAudio}
          notice={audioRetryNotice}
          onRetry={() => void handleRetryAudio()}
          onCheckAgain={() => void fetchDetail()}
        />
      )}
      {transcriptionProgress && (
        <TranscriptionBanner
          progress={transcriptionProgress}
          engineLabel={engineDisplayName(transcribeOptions.engine, transcribeOptions.modalAsrModel)}
          transcribing={transcribing}
          cancelling={cancellingTranscription}
          onCancel={() => void handleCancelTranscription()}
        />
      )}
      {!transcribing && !transcriptionProgress && meeting.status === "error" && meeting.lastError && (
        <Banner
          tone="error"
          icon={<CircleAlert className="h-4 w-4 text-error" aria-hidden="true" />}
          title="The last transcription failed"
          actions={
            !hasNoAudio && (
              <button type="button" onClick={() => setShowTranscribeModal(true)} className="btn btn-sm min-h-11 lg:min-h-0">
                Try again…
              </button>
            )
          }
        >
          {meeting.lastError}
        </Banner>
      )}
      {splitResult && (
        <Banner
          tone="success"
          icon={<Scissors className="h-4 w-4 text-primary" aria-hidden="true" />}
          title="Meeting split in two"
          onDismiss={() => setSplitResult(null)}
          actions={
            <button type="button" onClick={() => navigateTo(`/meetings/${splitResult.newMeetingId}`)} className="btn btn-sm min-h-11 lg:min-h-0">
              Open part 2
            </button>
          }
        >
          Part 2 was created as “{splitResult.newTitle}”.
        </Banner>
      )}
    </div>
  );

  const content =
    docTab === "summary" ? (
      <SummaryTab
        meetingTitle={meeting.title}
        summaries={summaries}
        activeSummary={activeSummary}
        generation={summaryGeneration}
        canGenerate={!summaryGenerating && !hasNoAudio}
        modelNames={modelNames}
        onSelect={setSelectedSummaryId}
        onSetPrimary={(id) => void handleSetPrimarySummary(id)}
        onDelete={(id) => void handleDeleteSummary(id)}
        onNewSummary={() => setShowSummaryModal(true)}
        onCopied={(ok) => notify(ok ? "success" : "error", ok ? "Summary copied" : "Couldn't copy to the clipboard")}
      />
    ) : (
      <TranscriptTab
        turns={turns}
        rawContent={detail.transcriptContent}
        activeTurnIdx={activeTurnIdx}
        isPlaying={isPlaying}
        playingSegmentIndex={playingSegmentIndex}
        isDesktop={isDesktop}
        actions={turnActions}
        emptyAction={transcribing ? <span className="text-sm text-base-content/60">Transcription in progress…</span> : transcribeButton}
      />
    );

  const speakersPanel = (
    <SpeakersPanel
      meetingId={meetingId}
      stats={stats}
      knownSpeakers={knownSpeakers}
      refreshKey={detail.transcriptContent}
      reidentifying={reidentifyingSpeakers}
      reidentifyStatus={reidentifyStatus}
      playingSegmentIndex={playingSegmentIndex}
      similarity={transcribeOptions.similarityThreshold}
      clustering={transcribeOptions.clusteringThreshold}
      onSimilarityChange={(v) => setTranscribeOptions((o) => ({ ...o, similarityThreshold: v }))}
      onClusteringChange={(v) => setTranscribeOptions((o) => ({ ...o, clusteringThreshold: v }))}
      onReidentify={() => void handleReidentifySpeakers()}
      onChangeSpeaker={(label, segmentIndex) => setReassigningSpeaker({ speaker: label, segmentIndex })}
      onOpenRapidEnroll={() => setShowRapidEnroll(true)}
      onPlaySample={(sample) => handlePlaySegment(sample, sample.segmentIndex)}
      onAssigned={() => {
        void fetchDetail();
        onSpeakerUpdated();
      }}
    />
  );

  const propertyList = (
    <PropertyList
      detail={detail}
      stats={stats}
      durationMs={durationMs}
      languageLabel={languageLabel}
      usage={usage}
      onSaveStartTime={saveStartTime}
      onSaveTags={(tags) => void saveTags(tags)}
      savingTags={savingTags}
      onOpenSpeakers={openSpeakers}
    />
  );

  const detailsPanel = (withProperties: boolean) => (
    <DetailsPanel
      detail={detail}
      usage={usage}
      durationMs={durationMs}
      canSplit={canSplit}
      onDownloadAudio={hasAudioFile ? downloadAudio : null}
      onSplit={() => setSplitModal({ initialMs: playheadMs() })}
      onMerge={() => setShowMergeModal(true)}
      onRetryAudio={meeting.canRetryAudio ? () => void handleRetryAudio() : null}
      onDelete={() => void handleDeleteMeeting()}
    >
      {withProperties ? propertyList : null}
    </DetailsPanel>
  );

  const title = (
    <MeetingTitle
      title={meeting.title}
      onSave={saveTitle}
      onSuggest={() => void handleAutoTitle()}
      suggesting={autoTitling}
      editing={editingTitle}
      onEditingChange={setEditingTitle}
    />
  );

  const audioElement = hasAudioFile ? (
    <audio
      ref={setAudioRef}
      preload="metadata"
      src={`/api/meetings/${meetingId}/audio?enhanced=${enhancedAudio}`}
      className="hidden"
      onLoadedMetadata={() => {
        const secs = audioRef.current?.duration;
        if (secs && Number.isFinite(secs)) setAudioDurationMs(Math.round(secs * 1000));
      }}
      onPlay={() => setIsPlaying(true)}
      onTimeUpdate={() => {
        const audio = audioRef.current;
        if (!audio) return;
        if (playbackStopMsRef.current !== null && audio.currentTime >= playbackStopMsRef.current / 1000) {
          audio.pause();
          playbackStopMsRef.current = null;
          setPlayingSegmentIndex(null);
        }
        setActiveTurnIdx(turnIndexAt(turns, Math.round(audio.currentTime * 1000)));
      }}
      onPause={() => {
        setIsPlaying(false);
        setPlayingSegmentIndex(null);
        playbackStopMsRef.current = null;
      }}
      onEnded={() => {
        setIsPlaying(false);
        setPlayingSegmentIndex(null);
        playbackStopMsRef.current = null;
      }}
    />
  ) : null;

  const modals = (
    <>
      {showSummaryModal && (
        <GenerateSummaryModal
          meetingId={meetingId}
          onClose={() => setShowSummaryModal(false)}
          onStarted={(status) => {
            setShowSummaryModal(false);
            setSummaryGeneration(status);
            setTab("summary");
          }}
        />
      )}

      {showTranscribeModal && (
        <TranscribeModal
          hasTranscript={hasTranscript}
          turnCount={turns.length}
          summaryCount={summaries.length}
          options={transcribeOptions}
          onOptionsChange={setTranscribeOptions}
          onClose={() => setShowTranscribeModal(false)}
          onConfirm={() => void handleTriggerTranscription()}
        />
      )}

      {splittingSegment && (
        <SplitSegmentModal
          meetingId={meetingId}
          segment={splittingSegment}
          knownSpeakers={knownSpeakers}
          onClose={() => setSplittingSegment(null)}
          onSuccess={async () => {
            setSplittingSegment(null);
            await fetchDetail();
            onSpeakerUpdated();
          }}
        />
      )}

      {splitModal && splitTotalMs !== null && (
        <SplitMeetingModal
          totalMs={splitTotalMs}
          initialMs={splitModal.initialMs}
          getPlayheadMs={playheadMs}
          busy={splittingMeeting}
          onClose={() => setSplitModal(null)}
          onConfirm={(ms) => void confirmSplitMeeting(ms)}
        />
      )}

      {showMergeModal && (
        <MergeMeetingModal
          meetingId={meetingId}
          meetingTitle={meeting.title}
          meetingStartTime={meeting.startTime}
          onClose={() => setShowMergeModal(false)}
          onMerged={(mergedId) => {
            setShowMergeModal(false);
            notify("success", "Meetings merged");
            if (mergedId && mergedId !== meetingId) {
              navigateTo(`/meetings/${mergedId}`);
            } else {
              void fetchDetail();
              setAudioDurationMs(null);
              if (audioRef.current) audioRef.current.load();
            }
          }}
        />
      )}

      {showRapidEnroll && (
        <RapidEnrollModal
          meetingId={meetingId}
          knownSpeakers={knownSpeakers}
          playingSegmentIndex={playingSegmentIndex}
          onPlaySample={(sample) => handlePlaySegment(sample, sample.segmentIndex)}
          onClose={() => setShowRapidEnroll(false)}
          onAssigned={() => {
            void fetchDetail();
            onSpeakerUpdated();
          }}
        />
      )}

      {reassigningSpeaker && (() => {
        const sampleTurn =
          reassigningSpeaker.segmentIndex !== undefined
            ? turns.find((t) => t.segmentIndex === reassigningSpeaker.segmentIndex)
            : turns.find((t) => t.speaker === reassigningSpeaker.speaker);
        const sampleIdx = sampleTurn ? turns.indexOf(sampleTurn) : -1;
        return (
          <ReassignSpeakerModal
            meetingId={meetingId}
            fromLabel={reassigningSpeaker.speaker}
            segmentIndex={reassigningSpeaker.segmentIndex}
            knownSpeakers={knownSpeakers}
            turnCount={turns.filter((t) => t.speaker === reassigningSpeaker.speaker).length}
            sample={hasAudioFile ? sampleTurn : undefined}
            samplePlaying={sampleIdx >= 0 && playingSegmentIndex === sampleIdx}
            onPlaySample={sampleTurn ? () => handlePlaySegment(sampleTurn, sampleIdx) : undefined}
            onClose={() => setReassigningSpeaker(null)}
            onSuccess={(optimistic) => {
              const prevLabel = reassigningSpeaker.speaker;
              setReassigningSpeaker(null);
              if (optimistic && detail?.transcriptContent) {
                try {
                  const parsedContent = JSON.parse(detail.transcriptContent);
                  const targetArray = Array.isArray(parsedContent.segments)
                    ? parsedContent.segments
                    : Array.isArray(parsedContent)
                    ? parsedContent
                    : null;
                  if (targetArray) {
                    if (optimistic.scope === "single" && optimistic.segmentIndex !== undefined) {
                      if (targetArray[optimistic.segmentIndex]) {
                        targetArray[optimistic.segmentIndex].speaker = optimistic.targetName;
                        targetArray[optimistic.segmentIndex].verified = true;
                      }
                    } else {
                      for (const s of targetArray) {
                        if ((s.speaker || "").trim().toLowerCase() === prevLabel.trim().toLowerCase()) {
                          s.speaker = optimistic.targetName;
                          s.verified = true;
                        }
                      }
                    }
                    setDetail((prev) => (prev ? { ...prev, transcriptContent: JSON.stringify(parsedContent) } : prev));
                  }
                } catch {}
              }
            }}
            onSettled={() => {
              void fetchDetail();
              onSpeakerUpdated();
            }}
          />
        );
      })()}

      {/* Keeps App's (legacy) chat drawer header in sync. */}
      <ChatTitleReporter title={meeting.title} onChatTitle={onChatTitle} />
    </>
  );

  /* ---------------------------------------------------------------- */
  /* Mobile layout                                                     */
  /* ---------------------------------------------------------------- */

  if (!isDesktop) {
    const showPlayer = hasAudioFile && mobileTab !== "chat";
    return (
      <div className="min-w-0">
        {audioElement}
        <div className="-mx-2 -mt-3 flex items-center gap-1">
          <button type="button" onClick={onBack} aria-label="Back to meetings" className="btn btn-ghost btn-square h-11 w-11">
            <ChevronLeft className="h-5 w-5" aria-hidden="true" />
          </button>
          <span className="flex-1 text-sm text-base-content/60">Meetings</span>
          <button type="button" onClick={() => setSheet("speakers")} aria-label="Speakers" className="btn btn-ghost btn-square relative h-11 w-11">
            <Users className="h-5 w-5" aria-hidden="true" />
            {needsReview > 0 && <span className="absolute top-2.5 right-2.5 h-2 w-2 rounded-full bg-warning" aria-hidden="true" />}
          </button>
          {moreMenu}
        </div>

        <div className="mt-1 space-y-2.5">
          {title}
          <button type="button" onClick={() => setSheet("details")} className="block text-left" aria-label="Show all details">
            <PropertyChips detail={detail} durationMs={durationMs} languageLabel={languageLabel} />
          </button>
        </div>

        <div className="mt-4">{banners}</div>

        <div ref={mobileTabsAnchorRef} aria-hidden="true" />
        <div className="sticky top-[calc(53px+env(safe-area-inset-top))] z-10 -mx-4 mt-3 bg-base-100 px-4 py-2 sm:-mx-8 sm:px-8">
          <Segmented
            role="tablist"
            ariaLabel="Content"
            value={mobileTab}
            onChange={(next) => {
              setTab(next);
              // Chat fills the screen below the tabs: bring the tabs to the top.
              if (next === "chat") {
                window.requestAnimationFrame(() => {
                  const anchor = mobileTabsAnchorRef.current;
                  if (anchor) window.scrollTo({ top: anchor.getBoundingClientRect().top + window.scrollY - 53, behavior: "smooth" });
                });
              }
            }}
            options={[
              { value: "summary", label: "Summary" },
              { value: "transcript", label: "Transcript" },
              { value: "chat", label: "Chat" }
            ]}
          />
        </div>

        {mobileTab === "chat" ? (
          <MeetingChatInline meetingId={meetingId} className="-mx-4 h-[calc(100dvh-173px-env(safe-area-inset-top)-env(safe-area-inset-bottom))] min-h-[340px] sm:-mx-8" />
        ) : (
          <div className="mt-2 space-y-3">
            <div className="flex flex-wrap items-center justify-end gap-2">{tabActions}</div>
            {content}
          </div>
        )}

        {showPlayer && (
          <>
            <div className="h-28" aria-hidden="true" />
            <div className="fixed inset-x-0 bottom-[calc(59px+env(safe-area-inset-bottom))] z-20 border-t border-divider bg-base-100">
              <PlayerBar
                variant="mobile"
                audio={audioEl}
                isPlaying={isPlaying}
                fallbackDurationMs={durationMs}
                turns={turns}
                enhanced={enhancedAudio}
                onToggleEnhanced={toggleEnhanced}
              />
            </div>
          </>
        )}

        {sheet && (
          <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={sheet === "speakers" ? "Speakers" : "Details"}>
            <button type="button" aria-label="Close" tabIndex={-1} onClick={() => setSheet(null)} className="absolute inset-0 bg-black/40" />
            <div className="absolute inset-x-0 bottom-0 max-h-[88dvh] overflow-y-auto rounded-t-box bg-base-100 pb-safe shadow-pop">
              <div className="sticky top-0 z-10 flex items-center justify-between bg-base-100 px-2 pt-1">
                <span className="w-11" aria-hidden="true" />
                <span className="h-1 w-10 rounded-full bg-base-300" aria-hidden="true" />
                <button type="button" onClick={() => setSheet(null)} aria-label="Close" className="btn btn-ghost btn-square h-11 w-11">
                  <X className="h-5 w-5" aria-hidden="true" />
                </button>
              </div>
              {sheet === "speakers" ? speakersPanel : detailsPanel(true)}
            </div>
          </div>
        )}

        {modals}
      </div>
    );
  }

  /* ---------------------------------------------------------------- */
  /* Desktop layout                                                    */
  /* ---------------------------------------------------------------- */

  const panelHeight = hasAudioFile ? "calc(100dvh - 2.75rem - 61px)" : "calc(100dvh - 2.75rem)";
  const panelButtons: { key: Panel; label: string }[] = [
    { key: "chat", label: "Chat" },
    { key: "speakers", label: "Speakers" },
    { key: "details", label: "Details" }
  ];

  return (
    <div className="-mb-16 flex min-h-dvh min-w-0 flex-col">
      {audioElement}
      <header className="sticky top-0 z-30 flex h-11 shrink-0 items-center justify-between gap-2 border-b border-divider bg-base-100 pr-3 pl-4">
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm text-base-content/60">
          <a
            href="/meetings"
            onClick={(e) => {
              e.preventDefault();
              onBack();
            }}
            className="rounded px-1.5 py-0.5 hover:bg-hover hover:text-base-content"
          >
            Meetings
          </a>
          <span aria-hidden="true">/</span>
          <span className="truncate text-base-content" aria-current="page">
            {meeting.title}
          </span>
        </nav>
        <div className="flex shrink-0 items-center gap-0.5">
          {panelButtons.map((p) => (
            <button
              key={p.key}
              type="button"
              aria-pressed={panel === p.key}
              onClick={() => togglePanel(p.key)}
              className={`relative h-[30px] rounded-md px-2.5 text-[13px] font-medium transition ${
                panel === p.key ? "bg-active text-base-content" : "text-base-content/60 hover:bg-hover hover:text-base-content"
              }`}
            >
              {p.label}
              {p.key === "speakers" && needsReview > 0 && (
                <span className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-warning" aria-label={`${needsReview} speakers to review`} />
              )}
            </button>
          ))}
          <span className="mx-1.5 h-[18px] w-px bg-divider" aria-hidden="true" />
          {moreMenu}
        </div>
      </header>

      <div className="flex min-w-0 flex-1 items-start">
        <article className="min-w-0 flex-1 px-8 pt-9 pb-16 xl:px-14">
          <div className="mx-auto max-w-3xl space-y-6">
            {title}
            {propertyList}
            {banners}
            <div>
              <div className="flex flex-wrap items-end justify-between gap-3 border-b border-divider">
                <div role="tablist" aria-label="Content" className="flex gap-1">
                  {(["summary", "transcript"] as const).map((key) => {
                    const on = docTab === key;
                    const count = key === "summary" ? summaries.length : turns.length;
                    return (
                      <button
                        key={key}
                        type="button"
                        role="tab"
                        aria-selected={on}
                        onClick={() => setTab(key)}
                        className={`-mb-px h-10 rounded-t px-2.5 text-sm transition hover:bg-hover ${
                          on ? "border-b-2 border-base-content font-semibold" : "border-b-2 border-transparent text-base-content/70"
                        }`}
                      >
                        {key === "summary" ? "Summary" : "Transcript"}{" "}
                        {count > 0 && <span className="font-normal text-base-content/50">{count}</span>}
                      </button>
                    );
                  })}
                </div>
                <div className="flex items-center gap-1.5 pb-1.5">{tabActions}</div>
              </div>
              <div className="pt-5">{content}</div>
            </div>
          </div>
        </article>

        {panel && (
          <aside
            aria-label={`${panel} panel`}
            className={`sticky top-11 flex w-[380px] shrink-0 flex-col border-l border-divider bg-base-200/50 xl:w-[400px] ${panel === "chat" ? "" : "overflow-y-auto"}`}
            style={{ height: panelHeight }}
          >
            {panel === "chat" ? (
              <MeetingChatInline meetingId={meetingId} className="h-full" />
            ) : panel === "speakers" ? (
              speakersPanel
            ) : (
              detailsPanel(false)
            )}
          </aside>
        )}
      </div>

      {hasAudioFile && (
        <div className="sticky bottom-0 z-20 border-t border-divider bg-base-100">
          <PlayerBar
            variant="desktop"
            audio={audioEl}
            isPlaying={isPlaying}
            fallbackDurationMs={durationMs}
            turns={turns}
            enhanced={enhancedAudio}
            onToggleEnhanced={toggleEnhanced}
          />
        </div>
      )}

      {modals}
    </div>
  );
}
