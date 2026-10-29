import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { Check, ClipboardList, Ellipsis, Eye, FileText, Link2, Mic, Pause, Pencil, Play, RotateCw, Save, Scissors, Settings, Sparkles, Star, VolumeX, X, Zap } from "lucide-react";
import { Combobox } from "../components/Combobox";
import { confirmAction, notify } from "../components/ui";
import { ENGINE_OPTIONS, MODAL_ASR_MODEL_OPTIONS, type ModalAsrModel, TRANSCRIPTION_AUTO_LABEL, languageOptions } from "../components/OptionComboboxes";
import type { MeetingListItem, Recording, Speaker, SummaryGenerationStatus, SpeakerReidentificationStatus, TranscriptionProgressUpdate } from "../api/types.ts";
import { MeetingDetailResponse, SpeakerWithStats, isGenericSpeakerLabel, formatDate, toDatetimeLocalValue, formatDuration, formatTimeOffset, MarkdownRenderer } from "../lib/common";
import { ChatTitleReporter } from "./MeetingChat";
import { App } from "../App";
import { Modal } from "./AppModals";
import { GenerateSummaryModal, RapidEnrollModal, ReassignSpeakerModal, SplitSegmentModal } from "./meetingModals";
import { MeetingUsageLine } from "./Usage";

export function SegmentActionsMenu({
  showConfirm,
  showMerge,
  showWrong,
  onConfirm,
  onChange,
  onSplit,
  onMerge,
  onWrong
}: {
  showConfirm: boolean;
  showMerge: boolean;
  showWrong: boolean;
  onConfirm: () => void;
  onChange: () => void;
  onSplit: () => void;
  onMerge: () => void;
  onWrong: () => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const pick = (action: () => void) => {
    setOpen(false);
    action();
  };
  const itemClass = "flex w-full min-h-[44px] items-center gap-2 rounded-field px-3 text-left text-sm transition hover:bg-base-200 focus-visible:bg-base-200";

  return (
    <div className="relative shrink-0" onKeyDown={(event) => {
      if (event.key === "Escape") setOpen(false);
    }}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Turn actions"
        onClick={() => setOpen((prev) => !prev)}
        className="btn btn-ghost btn-square min-h-[44px] min-w-[44px] text-lg leading-none"
      >
        <Ellipsis className="h-4 w-4 shrink-0" aria-hidden="true" />
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-label="Close turn actions"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 cursor-default"
          />
          <div role="menu" className="menu absolute right-0 top-full z-50 mt-1 min-w-[190px] rounded-box border border-base-300 bg-base-100 p-1 shadow-lg">
            {showConfirm && (
              <button type="button" role="menuitem" className={`${itemClass} font-semibold text-primary`} onClick={() => pick(onConfirm)} title="Confirm this speaker is correct & update voiceprint">
                <Check className="h-4 w-4 shrink-0" aria-hidden="true" /> Confirm
              </button>
            )}
            <button type="button" role="menuitem" className={`${itemClass} text-base-content`} onClick={() => pick(onChange)} title="Change speaker for this turn or all turns">
              <Pencil className="h-4 w-4 shrink-0" aria-hidden="true" /> Change
            </button>
            <button type="button" role="menuitem" className={`${itemClass} text-warning`} onClick={() => pick(onSplit)} title="Split this turn into two separate segments">
              <Scissors className="h-4 w-4 shrink-0" aria-hidden="true" /> Split
            </button>
            {showMerge && (
              <button type="button" role="menuitem" className={`${itemClass} text-base-content`} onClick={() => pick(onMerge)} title="Merge this turn with the following turn">
                <Link2 className="h-4 w-4 shrink-0" aria-hidden="true" /> Merge
              </button>
            )}
            {showWrong && (
              <button type="button" role="menuitem" className={`${itemClass} text-error`} onClick={() => pick(onWrong)} title="Mark as incorrect (reset to Unknown speaker)">
                <X className="h-4 w-4 shrink-0" aria-hidden="true" /> Wrong
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function MeetingDetailView({
  meetingId,
  knownSpeakers,
  onBack,
  onDeleted,
  onSpeakerUpdated,
  onChatOpenChange,
  onChatTitle
}: {
  meetingId: string;
  knownSpeakers: SpeakerWithStats[];
  onBack: () => void;
  onDeleted: () => void;
  onSpeakerUpdated: () => void;
  onChatOpenChange: (open: boolean) => void;
  onChatTitle: (title: string) => void;
}): ReactElement {
  const [detail, setDetail] = useState<MeetingDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [cancellingTranscription, setCancellingTranscription] = useState(false);
  const [transcriptionProgress, setTranscriptionProgress] = useState<TranscriptionProgressUpdate | null>(null);
  const transcriptionAbortRef = useRef<AbortController | null>(null);
  const [selectedEngine, setSelectedEngine] = useState<string>("local:cohere");
  const [modalAsrModel, setModalAsrModel] = useState<ModalAsrModel>("cohere");
  const [transcriptionLanguage, setTranscriptionLanguage] = useState("");
  const [showDiarizationSettings, setShowDiarizationSettings] = useState(false);
  const [customClusteringThreshold, setCustomClusteringThreshold] = useState(0.50);
  const [customSimilarityThreshold, setCustomSimilarityThreshold] = useState(0.45);
  const [enhancedAudio, setEnhancedAudio] = useState(true);
  const [reassigningSpeaker, setReassigningSpeaker] = useState<{ speaker: string; segmentIndex?: number } | null>(null);
  const [reidentifyingSpeakers, setReidentifyingSpeakers] = useState(false);
  const [reidentifyStatus, setReidentifyStatus] = useState<SpeakerReidentificationStatus | null>(null);
  const [showRapidEnroll, setShowRapidEnroll] = useState(false);
  const [splittingSegment, setSplittingSegment] = useState<{ segmentIndex: number; speaker: string; text: string; startMs: number; endMs: number } | null>(null);
  const [showSummaryModal, setShowSummaryModal] = useState(false);
  const [selectedSummaryId, setSelectedSummaryId] = useState<string | null>(null);
  const [summaryViewMode, setSummaryViewMode] = useState<"rendered" | "raw">("rendered");
  const [regenerating, setRegenerating] = useState(false);
  const [summaryGeneration, setSummaryGeneration] = useState<SummaryGenerationStatus | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmationNotice, setConfirmationNotice] = useState<string | null>(null);
  const [playingSegmentIndex, setPlayingSegmentIndex] = useState<number | null>(null);
  const playbackStopMsRef = useRef<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleInput, setTitleInput] = useState("");
  const [savingTitle, setSavingTitle] = useState(false);
  const [autoTitling, setAutoTitling] = useState(false);
  const [editingStartTime, setEditingStartTime] = useState(false);
  const [startTimeInput, setStartTimeInput] = useState("");
  const [savingStartTime, setSavingStartTime] = useState(false);
  const [newTagInput, setNewTagInput] = useState("");
  const [savingTags, setSavingTags] = useState(false);
  const [mobileSection, setMobileSection] = useState<"summary" | "transcript" | null>(null);
  const [retryingAudio, setRetryingAudio] = useState(false);
  const [audioRetryNotice, setAudioRetryNotice] = useState<string | null>(null);
  const [audioDurationMs, setAudioDurationMs] = useState<number | null>(null);
  const [splitMs, setSplitMs] = useState<number | null>(null);
  const [showSplitCard, setShowSplitCard] = useState(false);
  const [showSplitConfirm, setShowSplitConfirm] = useState(false);
  const [splittingMeeting, setSplittingMeeting] = useState(false);
  const [splitResult, setSplitResult] = useState<{ newMeetingId: string; newTitle: string } | null>(null);

  const audioStatus = detail?.meeting.audioStatus ?? (detail && detail.recordings.length === 0 ? "retrieving" : "ready");
  const hasNoAudio = !!detail && audioStatus !== "ready";

  const handleRetryAudio = async () => {
    if (retryingAudio) return;
    setRetryingAudio(true);
    setAudioRetryNotice(null);
    try {
      const res = await fetch(`/api/meetings/${meetingId}/audio/retry`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setAudioRetryNotice("Refetch queued — the audio will appear automatically once Plaud Cloud serves it.");
      await fetchDetail();
    } catch (err) {
      setAudioRetryNotice(err instanceof Error ? err.message : "Failed to queue audio refetch");
    } finally {
      setRetryingAudio(false);
    }
  };

  const splitTotalMs =
    audioDurationMs ?? detail?.recordings[0]?.durationMs ?? null;
  const SPLIT_EDGE_MS = 5000;
  const splitValid =
    splitMs !== null &&
    splitTotalMs !== null &&
    splitMs >= SPLIT_EDGE_MS &&
    splitMs <= splitTotalMs - SPLIT_EDGE_MS;
  const splitAllowedAt = (ms: number) =>
    splitTotalMs === null || (ms >= SPLIT_EDGE_MS && ms <= splitTotalMs - SPLIT_EDGE_MS);
  const clampSplitMs = (ms: number) =>
    splitTotalMs === null
      ? ms
      : Math.min(Math.max(ms, SPLIT_EDGE_MS), splitTotalMs - SPLIT_EDGE_MS);

  const confirmSplitMeeting = async () => {
    if (splitMs === null || splittingMeeting) return;
    setSplittingMeeting(true);
    setError(null);
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
      setShowSplitConfirm(false);
      setShowSplitCard(false);
      setSplitMs(null);
      setSplitResult({ newMeetingId: data.newMeeting.id, newTitle: data.newMeeting.title });
      await fetchDetail();
      // The audio file changed on disk: drop the cached duration (which
      // otherwise keeps splitTotalMs pinned to the pre-split length) and
      // force the <audio> element to re-request instead of replaying its
      // buffered/stale source.
      setAudioDurationMs(null);
      if (audioRef.current) audioRef.current.load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to split meeting");
    } finally {
      setSplittingMeeting(false);
    }
  };

  const startRename = () => {
    if (!detail) return;
    setTitleInput(detail.meeting.title);
    setEditingTitle(true);
    setError(null);
  };

  const saveTitle = async () => {
    const title = titleInput.trim();
    if (!title) {
      setError("Meeting title cannot be empty");
      return;
    }

    setSavingTitle(true);
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
      setEditingTitle(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rename meeting");
    } finally {
      setSavingTitle(false);
    }
  };

  const startEditStartTime = () => {
    if (!detail) return;
    setStartTimeInput(toDatetimeLocalValue(detail.meeting.startTime));
    setEditingStartTime(true);
    setError(null);
  };

  const saveStartTime = async () => {
    const ms = new Date(startTimeInput).getTime();
    if (!startTimeInput || Number.isNaN(ms)) {
      setError("Enter a valid meeting date and time");
      return;
    }

    setSavingStartTime(true);
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
        prev
          ? {
              ...prev,
              meeting: {
                ...prev.meeting,
                startTime: data.meeting!.startTime,
                endTime: data.meeting!.endTime
              }
            }
          : prev
      );
      setEditingStartTime(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update meeting time");
    } finally {
      setSavingStartTime(false);
    }
  };

  const handleAutoTitle = async () => {
    if (autoTitling || savingTitle || editingTitle) return;
    setAutoTitling(true);
    setError(null);
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
      setError(err instanceof Error ? err.message : "Failed to auto-generate title");
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
      setError(err instanceof Error ? err.message : "Failed to update tags");
    } finally {
      setSavingTags(false);
    }
  };

  const handleAddTag = () => {
    const tag = newTagInput.trim();
    if (!tag) return;
    const current = detail?.meeting.tags ?? [];
    if (current.includes(tag)) {
      setNewTagInput("");
      return;
    }
    setNewTagInput("");
    void saveTags([...current, tag]);
  };

  const handleRemoveTag = (tag: string) => {
    const current = detail?.meeting.tags ?? [];
    void saveTags(current.filter((t) => t !== tag));
  };

  const fetchDetail = async () => {
    if (!detail) {
      setLoading(true);
    }
    try {
      const [res, cfgRes] = await Promise.all([
        fetch(`/api/meetings/${meetingId}`),
        fetch("/api/config")
      ]);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as MeetingDetailResponse;
      setDetail(data);
      if (data.summaryGeneration?.stage === "running") {
        setSummaryGeneration(data.summaryGeneration);
      }
      if (data.speakerReidentification) {
        const stage = data.speakerReidentification.stage;
        if (stage === "queued" || stage === "running") {
          setReidentifyStatus(data.speakerReidentification);
          setReidentifyingSpeakers(true);
        } else {
          setReidentifyStatus(data.speakerReidentification);
          setReidentifyingSpeakers(false);
        }
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
      if (cfgRes.ok) {
        const cfg = await cfgRes.json();
        if (cfg.localClusteringThreshold !== undefined) setCustomClusteringThreshold(cfg.localClusteringThreshold);
        if (cfg.localSimilarityThreshold !== undefined) setCustomSimilarityThreshold(cfg.localSimilarityThreshold);
        if (cfg.transcriptionProvider === "speechmatics" || cfg.transcriptionProvider === "assemblyai" || cfg.transcriptionProvider === "muse" || cfg.transcriptionProvider === "modal") {
          setSelectedEngine(cfg.transcriptionProvider);
        } else {
          setSelectedEngine("local:cohere");
        }
        if (cfg.modalAsrModel) setModalAsrModel(cfg.modalAsrModel);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load meeting");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchDetail();

    let eventSource: EventSource | null = null;
    let isClosed = false;

    const connectProgress = () => {
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
            setTranscriptionProgress(data);
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
    };

    connectProgress();

    return () => {
      isClosed = true;
      if (eventSource) {
        eventSource.close();
      }
    };
  }, [meetingId]);

  const summaryGenerating = summaryGeneration?.stage === "running";

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
    if (hasNoAudio) {
      setError(
        audioStatus === "retrieving"
          ? "Audio is still being fetched from Plaud Cloud — transcription unlocks once it lands."
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
      message: "Starting transcription pipeline..."
    });

    const isLocal = selectedEngine.startsWith("local");
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
          provider: isLocal ? "local" : selectedEngine,
          modelId: isLocal ? modelId : undefined,
          poll: true,
          force: true,
          clusteringThreshold: isLocal ? customClusteringThreshold : undefined,
          similarityThreshold: isLocal ? customSimilarityThreshold : undefined,
          asrModel: selectedEngine === "modal" ? modalAsrModel : undefined,
          language: transcriptionLanguage || undefined
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

  const handleReidentifySpeakers = async () => {
    if (!detail || reidentifyingSpeakers) return;
    setReidentifyingSpeakers(true);
    setError(null);
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
      setError(err instanceof Error ? err.message : "Failed to re-identify speakers");
    } finally {
      setReidentifyingSpeakers(false);
    }
  };

  const handleDeleteMeeting = async () => {
    if (!detail) return;
    if (
      !(await confirmAction({ title: "Delete meeting", message: `Are you sure you want to delete meeting "${detail.meeting.title}"? This will permanently remove its recordings, transcripts, and summaries.`, confirmLabel: "Delete", danger: true }))
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

  const handleDeleteSummary = async (artifactId: string) => {
    if (!(await confirmAction({ title: "Delete summary", message: "Are you sure you want to delete this summary?", confirmLabel: "Delete", danger: true }))) {
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

  const handleCopySummary = (content: string) => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
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

      if (data.voiceprintStatus === "enrolled") {
        setConfirmationNotice(`✓ Confirmed "${data.speaker?.name || "speaker"}" & enrolled voiceprint sample`);
      } else if (data.voiceprintStatus === "enrolled_evicted") {
        setConfirmationNotice(`✓ Confirmed "${data.speaker?.name || "speaker"}" (pool full: rotated oldest confirmed clip)`);
      } else if (data.voiceprintStatus === "redundant_skipped") {
        setConfirmationNotice(`✓ Confirmed "${data.speaker?.name || "speaker"}" (profile already optimal — redundant audio skipped)`);
      } else if (data.voiceprintStatus === "outlier_rejected") {
        setConfirmationNotice(`✓ Confirmed "${data.speaker?.name || "speaker"}" in transcript (voiceprint skipped: acoustic mismatch/noise)`);
      } else if (data.voiceprintStatus === "duration_skipped") {
        setConfirmationNotice(`✓ Confirmed "${data.speaker?.name || "speaker"}" in transcript (voiceprint skipped: clip under 3s — too short to enroll)`);
      } else {
        setConfirmationNotice(`✓ Confirmed "${data.speaker?.name || "speaker"}"`);
      }
      setTimeout(() => setConfirmationNotice(null), 4000);

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
      notify("error", `Failed to merge segments: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

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

  let parsedTranscriptSegments: Array<{
    speaker: string;
    text: string;
    startMs: number;
    endMs: number;
    verified?: boolean;
    segmentIndex: number;
  }> = [];
  if (detail?.transcriptContent) {
    try {
      const parsed = JSON.parse(detail.transcriptContent);
      if (Array.isArray(parsed.segments)) {
        parsedTranscriptSegments = parsed.segments.map((s: any, idx: number) => ({
          speaker: s.speaker || "Speaker",
          text: s.text || s.content || "",
          startMs: s.startMs ?? s.start_time ?? 0,
          endMs: s.endMs ?? s.end_time ?? 0,
          verified: Boolean(s.verified),
          segmentIndex: idx
        }));
      } else if (Array.isArray(parsed)) {
        parsedTranscriptSegments = parsed
          .filter((item: any) => (item.text && item.text.trim()) || (item.content && item.content.trim()))
          .map((item: any, idx: number) => ({
            speaker: item.speaker || "Speaker",
            text: item.text || item.content || "",
            startMs: item.startMs ?? item.start_time ?? 0,
            endMs: item.endMs ?? item.end_time ?? 0,
            verified: Boolean(item.verified),
            segmentIndex: idx
          }));
      }
    } catch {
      // plain text fallback
    }
  }

  const summaries = detail?.summaries || [];
  const activeSummary =
    summaries.find((s) => s.id === selectedSummaryId) ||
    summaries.find((s) => s.isPrimary) ||
    summaries[0] ||
    null;

  // Phone/tablet-portrait only: pick the active segment (defaults to Summary when one exists, else Transcript).
  const activeSection = mobileSection ?? (summaries.length > 0 ? "summary" : "transcript");

  return (
    <div className="space-y-6">
      <button
        type="button"
        onClick={onBack}
        className="flex min-h-[44px] items-center gap-2 text-sm text-base-content/70 hover:text-primary transition"
      >
        ← Back to Meetings
      </button>

      {loading && <p className="text-base-content/70">Loading meeting details…</p>}
      {error && <div className="rounded-xl border border-error bg-error/10 p-4 text-error">{error}</div>}

      {detail && (
        <div className="space-y-8">
          <header className="space-y-4 border-b border-base-300 pb-6">
            <div className="w-full">
              {editingTitle ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveTitle();
                  }}
                  className="w-full"
                >
                  <input
                    type="text"
                    value={titleInput}
                    onChange={(event) => setTitleInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setEditingTitle(false);
                    }}
                    aria-label="Meeting title"
                    autoFocus
                    disabled={savingTitle}
                    className="input w-full text-2xl font-bold tracking-tight sm:text-3xl"
                  />
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <button
                      type="submit"
                      disabled={savingTitle}
                      className="btn btn-primary min-h-11"
                    >
                      {savingTitle ? "Saving…" : "Save"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingTitle(false)}
                      disabled={savingTitle}
                      className="btn min-h-11"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <h1 className="text-2xl sm:text-3xl font-bold tracking-tight break-words">{detail.meeting.title}</h1>
                  <div className="mt-2 flex flex-wrap items-center gap-1">
                    <button
                      type="button"
                      onClick={startRename}
                      className="btn btn-ghost px-1.5 min-h-11"
                      aria-label="Rename meeting"
                      title="Rename meeting"
                    >
                      <Pencil className="h-4 w-4 shrink-0" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleAutoTitle()}
                      disabled={autoTitling || savingTitle}
                      className="btn btn-ghost btn-sm inline-flex items-center gap-1.5 font-medium min-h-11"
                      aria-label="Auto-generate meeting title with default LLM"
                      title="Auto-generate title with default LLM"
                    >
                      <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                      {autoTitling ? "Titling…" : "Auto-title"}
                    </button>
                  </div>
                </>
              )}
            </div>
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 sm:gap-3 text-xs sm:text-sm text-base-content/70">
                  {editingStartTime ? (
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        void saveStartTime();
                      }}
                      className="flex flex-wrap items-center gap-2"
                    >
                      <input
                        type="datetime-local"
                        value={startTimeInput}
                        onChange={(event) => setStartTimeInput(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") setEditingStartTime(false);
                        }}
                        aria-label="Meeting start time"
                        autoFocus
                        disabled={savingStartTime}
                        className="input input-sm text-xs"
                      />
                      <button
                        type="submit"
                        disabled={savingStartTime}
                        className="btn btn-primary btn-sm min-h-11"
                      >
                        {savingStartTime ? "Saving…" : "Save"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingStartTime(false)}
                        disabled={savingStartTime}
                        className="rounded-md border border-base-300 px-2 py-1 text-xs text-base-content transition hover:border-base-300 hover:text-base-content disabled:opacity-50"
                      >
                        Cancel
                      </button>
                    </form>
                  ) : (
                    <>
                      <span>{formatDate(detail.meeting.startTime)}</span>
                      <button
                        type="button"
                        onClick={startEditStartTime}
                        className="btn btn-ghost px-1 py-0.5 min-h-11"
                        aria-label="Change meeting time"
                        title="Change meeting time"
                      >
                        <Pencil className="h-4 w-4 shrink-0" aria-hidden="true" />
                      </button>
                    </>
                  )}
                  <span>•</span>
                  <span>{formatDuration(detail.meeting.endTime - detail.meeting.startTime)}</span>
                  <span>•</span>
                  <span className="capitalize">{detail.meeting.source}</span>
                </div>
                <MeetingUsageLine meetingId={meetingId} />
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  {detail.meeting.tags.map((tag) => (
                    <span
                      key={tag}
                      className="inline-flex items-center gap-1.5 rounded-full border border-base-300 bg-base-300/80 pl-2.5 pr-1.5 py-1 text-xs text-base-content"
                    >
                      {tag}
                      <button
                        type="button"
                        onClick={() => handleRemoveTag(tag)}
                        disabled={savingTags}
                        className="text-base-content/50 hover:text-error transition disabled:opacity-50"
                        aria-label={`Remove tag ${tag}`}
                      >
                        <X className="h-4 w-4 shrink-0" aria-hidden="true" />
                      </button>
                    </span>
                  ))}
                  <input
                    type="text"
                    value={newTagInput}
                    onChange={(e) => setNewTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleAddTag();
                      }
                    }}
                    placeholder="+ Add tag"
                    disabled={savingTags}
                    className="input input-md w-full w-24 rounded-full border-dashed bg-transparent px-2.5 text-xs text-base-content placeholder:text-base-content/50 focus:w-32 transition-all disabled:opacity-50"
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              <button
                type="button"
                onClick={() => onChatOpenChange(true)}
                className="inline-flex min-h-[44px] basis-full items-center justify-center gap-2 rounded-lg border border-accent/40 bg-accent/10 px-3.5 py-2 text-sm font-semibold text-accent transition hover:border-accent/60 hover:bg-accent/20 shadow-md shrink-0 flex-1 sm:flex-none sm:basis-auto"
              >
                <span><Sparkles className="h-4 w-4 shrink-0" aria-hidden="true" /></span>
                <span>Chat with Meeting</span>
              </button>
              <div className="w-full sm:w-72">
                <Combobox
                  value={selectedEngine}
                  onChange={setSelectedEngine}
                  placeholder="Select engine…"
                  ariaLabel="Transcription engine"
                  searchPlaceholder="Search engines…"
                  options={ENGINE_OPTIONS}
                />
              </div>
              <div className="w-full sm:w-48">
                <Combobox
                  value={transcriptionLanguage}
                  onChange={setTranscriptionLanguage}
                  placeholder="Select language…"
                  ariaLabel="Transcription language"
                  searchPlaceholder="Search languages…"
                  options={languageOptions("Default language", TRANSCRIPTION_AUTO_LABEL)}
                />
              </div>

              {selectedEngine === "modal" && (
                <div className="w-full sm:w-64">
                  <Combobox
                    value={modalAsrModel}
                    onChange={(v) => setModalAsrModel(v as ModalAsrModel)}
                    placeholder="Select STT model…"
                    ariaLabel="Modal speech-to-text model"
                    searchPlaceholder="Search models…"
                    options={MODAL_ASR_MODEL_OPTIONS}
                  />
                </div>
              )}

              {selectedEngine.startsWith("local") && (
                <button
                  type="button"
                  onClick={() => setShowDiarizationSettings(!showDiarizationSettings)}
                  className={`min-h-[44px] rounded-lg border px-2.5 py-2 text-xs font-mono transition shrink-0 ${
                    showDiarizationSettings
                      ? "border-primary bg-primary/20 text-primary"
                      : "border-base-300 bg-base-200 text-base-content/70 hover:text-base-content"
                  }`}
                  title="Configure local diarization thresholds"
                >
                  <Settings className="h-4 w-4 shrink-0" aria-hidden="true" /> Thresholds
                </button>
              )}

              <button
                type="button"
                disabled={transcribing || hasNoAudio}
                onClick={() => void handleTriggerTranscription()}
                title={hasNoAudio ? "Transcription unlocks once the meeting audio is attached" : undefined}
                className="btn btn-primary inline-flex min-h-[44px] items-center gap-2 disabled:opacity-75 disabled:cursor-not-allowed shrink-0"
              >
                {transcribing && (
                  <svg className="h-4 w-4 animate-spin text-primary-content" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                )}
                <span>
                  {transcribing
                    ? transcriptionProgress
                      ? transcriptionProgress.stage === "diarizing"
                        ? `Diarizing (${Math.round(transcriptionProgress.percent || 15)}%)…`
                        : transcriptionProgress.stage === "uploading"
                        ? `Uploading (${Math.round(transcriptionProgress.percent || 15)}%)…`
                        : transcriptionProgress.stage === "decoding"
                        ? "Enhancing Audio…"
                        : `Transcribing (${Math.round(transcriptionProgress.percent || 25)}%)…`
                      : "Transcribing…"
                    : "Transcribe"}
                </span>
              </button>

              {transcribing && (
                <button
                  type="button"
                  disabled={cancellingTranscription}
                  onClick={() => void handleCancelTranscription()}
                  className="btn btn-error btn-soft inline-flex min-h-[44px] items-center gap-1.5 border hover:border-error/60 shadow-md shrink-0"
                  title="Cancel inflight transcription"
                >
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                  </svg>
                  <span>{cancellingTranscription ? "Cancelling…" : "Cancel"}</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => void handleDeleteMeeting()}
                className="btn btn-error btn-soft inline-flex min-h-[44px] items-center gap-1.5 border hover:border-error/60 shadow-md shrink-0"
                title="Delete this meeting and all its artifacts"
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6"></polyline>
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                </svg>
                <span>Delete</span>
              </button>
            </div>
            </div>
          </header>

          {/* Audio not yet attached — retrieving or missing banner */}
          {hasNoAudio && (
            <div
              className={`rounded-xl border p-4 shadow-xl space-y-3  ${
                audioStatus === "retrieving"
                  ? "border-info/30 bg-info/30"
                  : "border-error/30 bg-error/10"
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  {audioStatus === "retrieving" ? (
                    <svg className="h-4 w-4 animate-spin text-info shrink-0" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                    </svg>
                  ) : (
                    <span className="text-error shrink-0">⚠</span>
                  )}
                  <p className={`text-sm ${audioStatus === "retrieving" ? "text-info" : "text-error"}`}>
                    {audioStatus === "retrieving" ? (
                      <><span className="font-semibold">Retrieving audio…</span> This Plaud recording is still downloading from Plaud Cloud. Transcription unlocks automatically once it lands.</>
                    ) : detail?.meeting.source === "plaud" ? (
                      <><span className="font-semibold">Audio file missing.</span> The recording row exists but no audio is on disk. Re-queue the download from Plaud Cloud.</>
                    ) : (
                      <><span className="font-semibold">Audio file missing.</span> No playable audio is attached to this meeting, so transcription is unavailable.</>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {detail?.meeting.canRetryAudio && (
                    <button
                      type="button"
                      disabled={retryingAudio}
                      onClick={() => void handleRetryAudio()}
                      className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-info/40 bg-info/10 px-3 py-1.5 text-xs font-semibold text-info transition hover:bg-info/20 disabled:opacity-50"
                    >
                      <span><RotateCw className="h-4 w-4 shrink-0" aria-hidden="true" /></span>
                      <span>{retryingAudio ? "Queueing…" : "Retry download"}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void fetchDetail()}
                    className="btn btn-sm inline-flex min-h-[40px] items-center"
                  >
                    Check again
                  </button>
                </div>
              </div>
              {audioRetryNotice && (
                <p className="text-xs text-base-content">{audioRetryNotice}</p>
              )}
            </div>
          )}

          {/* Live Transcription Progress Banner */}
          {transcriptionProgress && (
            <div className="rounded-xl border border-primary/30 bg-base-200/95 p-4 shadow-xl space-y-3 ">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="relative flex h-2.5 w-2.5">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-primary"></span>
                  </span>
                  <span className="font-semibold text-base-content uppercase tracking-wide">
                    {selectedEngine.startsWith("local")
                      ? "Local Pipeline (Cohere Transcribe + Diarization)"
                      : selectedEngine === "assemblyai" ? "AssemblyAI Cloud" : selectedEngine === "muse" ? "Muse Voice Cloud" : selectedEngine === "modal" ? `Modal GPU (${modalAsrModel})` : "Speechmatics Cloud"}
                  </span>
                  <span className="text-base-content/50">•</span>
                  <span className="text-primary font-medium capitalize">
                    {transcriptionProgress.stage}
                  </span>
                </div>

                <div className="flex items-center gap-3 font-mono text-xs">
                  {transcriptionProgress.current && transcriptionProgress.total && (
                    <span className="text-base-content">
                      Segment <strong className="text-primary">{transcriptionProgress.current}</strong> / {transcriptionProgress.total}
                    </span>
                  )}
                  {transcriptionProgress.currentMs !== undefined && transcriptionProgress.totalMs && (
                    <span className="text-base-content/70">
                      {formatTimeOffset(transcriptionProgress.currentMs)} / {formatTimeOffset(transcriptionProgress.totalMs)}
                    </span>
                  )}
                  <span className="font-bold text-primary text-sm">
                    {Math.round(transcriptionProgress.percent)}%
                  </span>

                  {transcribing && (
                    <button
                      type="button"
                      disabled={cancellingTranscription}
                      onClick={() => void handleCancelTranscription()}
                      className="btn btn-error btn-soft btn-sm ml-1 inline-flex items-center gap-1 py-0.5 border min-h-11"
                    >
                      <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                      </svg>
                      <span>{cancellingTranscription ? "Cancelling…" : "Cancel"}</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Progress Bar */}
              <progress className="progress progress-primary w-full" value={Math.max(3, Math.min(100, transcriptionProgress.percent))} max={100} aria-label="Transcription progress" />

              {/* Status Message */}
              <div className="flex items-center justify-between text-xs text-base-content/70">
                <p className="truncate text-base-content">
                  {transcriptionProgress.message}
                </p>
                {transcriptionProgress.speaker && (
                  <span className="shrink-0 rounded bg-base-300 px-2 py-0.5 text-[11px] font-medium text-accent border border-base-300">
                    Speaker: {transcriptionProgress.speaker}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Expandable Diarization Threshold Tuning */}
          {showDiarizationSettings && selectedEngine.startsWith("local") && (
            <div className="rounded-xl border border-base-300 bg-base-200/90 p-4 space-y-3 backdrop-blur">
              <div className="flex items-center justify-between border-b border-base-300 pb-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-primary">
                  <Mic className="h-4 w-4 shrink-0" aria-hidden="true" /> Diarization & Voiceprint Thresholds for this Transcription
                </span>
                <span className="text-[11px] text-base-content/50 font-mono">Overrides Global Settings</span>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 pt-1">
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <label htmlFor="meeting-clustering-slider" className="text-base-content font-medium">
                      Within-Meeting Clustering Threshold:
                    </label>
                    <span className="font-mono font-bold text-primary">
                      {customClusteringThreshold.toFixed(2)}
                    </span>
                  </div>
                  <input
                    id="meeting-clustering-slider"
                    type="range"
                    min="0.10"
                    max="0.95"
                    step="0.01"
                    value={customClusteringThreshold}
                    onChange={(e) => setCustomClusteringThreshold(parseFloat(e.target.value))}
                    className="range range-sm w-full"
                  />
                  <p className="text-[10px] text-base-content/50">
                    Controls separation of distinct voices in this meeting. Recommended: 0.50.
                  </p>
                </div>

                <div className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <label htmlFor="meeting-similarity-slider" className="text-base-content font-medium">
                      Enrolled Speaker Recognition Sensitivity:
                    </label>
                    <span className="font-mono font-bold text-accent">
                      {customSimilarityThreshold.toFixed(2)}
                    </span>
                  </div>
                  <input
                    id="meeting-similarity-slider"
                    type="range"
                    min="0.10"
                    max="0.95"
                    step="0.01"
                    value={customSimilarityThreshold}
                    onChange={(e) => setCustomSimilarityThreshold(parseFloat(e.target.value))}
                    className="range range-sm w-full"
                  />
                  <p className="text-[10px] text-base-content/50">
                    Cosine similarity threshold to recognize known people. Recommended: 0.45.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Speakers summary */}
          {(() => {
            const activeSpeakerNames = new Set(
              parsedTranscriptSegments.map((s) => s.speaker.trim().toLowerCase()).filter(Boolean)
            );
            const visibleSpeakers = (
              activeSpeakerNames.size > 0
                ? detail.speakers.filter((s) => activeSpeakerNames.has(s.name.trim().toLowerCase()))
                : detail.speakers
            ).filter((s) => !isGenericSpeakerLabel(s.name));

            return visibleSpeakers.length > 0 || parsedTranscriptSegments.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-base-content/70">Speakers:</span>
                {visibleSpeakers.map((s) => (
                  <span
                    key={s.id}
                    className="rounded-full border border-base-300 bg-base-300/80 px-3 py-1 text-xs font-medium text-primary"
                  >
                    {s.name}
                  </span>
                ))}
                <button
                  type="button"
                  onClick={() => void handleReidentifySpeakers()}
                  disabled={reidentifyingSpeakers}
                  className="btn btn-sm rounded-full hover:border-primary/40 hover:text-primary disabled:cursor-wait min-h-11"
                  title="Re-match every speaker label against your current enrolled voiceprints"
                >
                  {reidentifyingSpeakers
                    ? reidentifyStatus?.stage === "queued"
                      ? <><RotateCw className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" /> Queued…</>
                      : <><RotateCw className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" /> Re-identifying…</>
                    : reidentifyStatus?.stage === "error"
                      ? <><RotateCw className="h-4 w-4 shrink-0" aria-hidden="true" /> Retry re-identify</>
                      : <><RotateCw className="h-4 w-4 shrink-0" aria-hidden="true" /> Re-identify</>}
                </button>
              </div>
            ) : null;
          })()}

          {/* Audio Player if recording exists */}
          {detail.recordings.length > 0 && (
            <section className="rounded-xl border border-base-300 bg-base-200/90 p-3.5 sm:p-4 space-y-2.5 shadow-lg w-full max-w-full min-w-0 overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-base-content/70">
                <div className="flex flex-wrap items-center gap-2 sm:gap-3 min-w-0">
                  <span className="font-semibold uppercase tracking-wider text-base-content shrink-0">Recording Audio</span>
                  <span className="truncate">{detail.recordings[0].mime} • {(detail.recordings[0].sizeBytes / 1024 / 1024).toFixed(2)} MB</span>
                  {playingSegmentIndex !== null && (
                    <span className="inline-flex items-center gap-1.5 rounded bg-primary/20 px-2 py-0.5 text-[11px] font-semibold text-primary border border-primary/40 animate-pulse shrink-0">
                      <span className="inline-flex items-center gap-1.5"><Play className="h-4 w-4 shrink-0" aria-hidden="true" /> Playing turn #{playingSegmentIndex + 1}</span>
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                {/* Voice Clarity Enhancement Toggle */}
                <button
                  type="button"
                  onClick={() => {
                    const currentTime = audioRef.current?.currentTime || 0;
                    const wasPlaying = !audioRef.current?.paused;
                    setEnhancedAudio(!enhancedAudio);
                    setTimeout(() => {
                      if (audioRef.current) {
                        audioRef.current.currentTime = currentTime;
                        if (wasPlaying) void audioRef.current.play();
                      }
                    }, 50);
                  }}
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition shrink-0 ${
                    enhancedAudio
                      ? "border-primary/40 bg-primary/10 text-primary hover:bg-primary/20"
                      : "border-base-300 bg-base-300 text-base-content/70 hover:text-base-content"
                  }`}
                  title="Toggle FFmpeg speech clarity equalizer & adaptive de-noiser"
                >
                  <span className="inline-flex items-center gap-1.5">{enhancedAudio ? <><Sparkles className="h-4 w-4 shrink-0" aria-hidden="true" /> Voice Enhanced (Active)</> : <><VolumeX className="h-4 w-4 shrink-0" aria-hidden="true" /> Original Raw Audio</>}</span>
                </button>
                {splitTotalMs !== null && splitTotalMs > 15000 && (
                  <button
                    type="button"
                    onClick={() => {
                      if (!showSplitCard && splitMs === null) {
                        const secs = audioRef.current?.currentTime;
                        if (secs && Number.isFinite(secs)) setSplitMs(clampSplitMs(Math.round(secs * 1000)));
                      }
                      setShowSplitCard(!showSplitCard);
                    }}
                    className={`btn btn-sm shrink-0 ${
                      showSplitCard
                        ? "btn-primary btn-soft"
                        : ""
                    }`}
                    title="Cut this meeting in two at a chosen point"
                  >
                    <span className="inline-flex items-center gap-1.5"><Scissors className="h-4 w-4 shrink-0" aria-hidden="true" /> Split Meeting</span>
                  </button>
                )}
                </div>
              </div>
              {splitResult && (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2 text-xs text-primary">
                  <span className="inline-flex items-center gap-1.5"><Check className="h-4 w-4 shrink-0" aria-hidden="true" /> Split complete — Part 2 created as “{splitResult.newTitle}”.</span>
                  <button
                    type="button"
                    onClick={() => window.location.assign(`/meetings/${splitResult.newMeetingId}`)}
                    className="btn btn-primary min-h-11"
                  >
                    Open Part 2 →
                  </button>
                  <button
                    type="button"
                    onClick={() => setSplitResult(null)}
                    className="text-primary/70 hover:text-primary"
                    aria-label="Dismiss split notice"
                  >
                    Dismiss
                  </button>
                </div>
              )}
              <div className="rounded-xl bg-base-300 p-1.5">
              <audio
                ref={audioRef}
                controls
                src={`/api/meetings/${meetingId}/audio?enhanced=${enhancedAudio}`}
                className="block w-full max-w-full h-10 sm:h-11 rounded-full [color-scheme:dark]"
                onLoadedMetadata={() => {
                  const secs = audioRef.current?.duration;
                  if (secs && Number.isFinite(secs)) setAudioDurationMs(Math.round(secs * 1000));
                }}
                onTimeUpdate={() => {
                  if (audioRef.current && playbackStopMsRef.current !== null) {
                    if (audioRef.current.currentTime >= playbackStopMsRef.current / 1000) {
                      audioRef.current.pause();
                      playbackStopMsRef.current = null;
                      setPlayingSegmentIndex(null);
                    }
                  }
                }}
                onPause={() => {
                  setPlayingSegmentIndex(null);
                  playbackStopMsRef.current = null;
                }}
                onEnded={() => {
                  setPlayingSegmentIndex(null);
                  playbackStopMsRef.current = null;
                }}
              />
              </div>
              {showSplitCard && splitTotalMs !== null && splitTotalMs > 15000 && (
                <div className="space-y-2 rounded-lg border border-base-300 bg-base-100/60 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="inline-flex items-center gap-1.5 font-semibold uppercase tracking-wider text-base-content/70"><Scissors className="h-4 w-4 shrink-0" aria-hidden="true" /> Split meeting</span>
                    <button
                      type="button"
                      onClick={() => {
                        const secs = audioRef.current?.currentTime;
                        if (secs && Number.isFinite(secs)) setSplitMs(clampSplitMs(Math.round(secs * 1000)));
                      }}
                      className="text-base-content/70 hover:text-primary"
                      title="Set the split point to the current playback position"
                    >
                      Use current position
                    </button>
                  </div>
                  <input
                    type="range"
                    min={Math.floor(SPLIT_EDGE_MS / 1000)}
                    max={Math.floor((splitTotalMs - SPLIT_EDGE_MS) / 1000)}
                    step={1}
                    value={splitMs !== null ? Math.floor(clampSplitMs(splitMs) / 1000) : Math.floor(SPLIT_EDGE_MS / 1000)}
                    onChange={(e) => setSplitMs(clampSplitMs(Number(e.target.value) * 1000))}
                    aria-label="Split point in seconds"
                    className="w-full accent-primary"
                  />
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-base-content/70">
                    <span>
                      {splitMs !== null ? (
                        <>Split at <span className="font-mono font-semibold text-base-content">{formatTimeOffset(splitMs)}</span> → Part 1: {formatTimeOffset(splitMs)} · Part 2: {formatTimeOffset(splitTotalMs - splitMs)}</>
                      ) : (
                        <>Drag to choose where Part 1 ends and Part 2 begins (total {formatTimeOffset(splitTotalMs)})</>
                      )}
                    </span>
                    <button
                      type="button"
                      disabled={!splitValid}
                      onClick={() => setShowSplitConfirm(true)}
                      className="btn btn-primary disabled:opacity-40 disabled:cursor-not-allowed min-h-11"
                      title={!splitValid ? "Drag the slider at least 5 seconds from either edge" : undefined}
                    >
                      Split meeting…
                    </button>
                  </div>
                </div>
              )}
            </section>
          )}

          {/* Phone/tablet-portrait section switcher (hidden at lg+, where all sections stack) */}
          <div className="lg:hidden sticky top-14 sm:top-16 z-20 bg-base-100 py-2">
            <div role="tablist" aria-label="Meeting sections" className="tabs tabs-box w-full">
              {(["summary", "transcript"] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={activeSection === key}
                  onClick={() => setMobileSection(key)}
                  className={`tab min-h-[44px] flex-1 ${activeSection === key ? "tab-active" : ""}`}
                >
                  {key === "summary" ? "Summary" : "Transcript"}
                </button>
              ))}
            </div>
          </div>

          {/* AI Summaries Section */}
          <section className={`space-y-4 ${activeSection !== "summary" ? "hidden lg:block" : ""}`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <h2 className="text-xl font-semibold tracking-tight">AI Summaries</h2>
                {summaries.length > 0 && (
                  <span className="rounded-full bg-base-300 px-2.5 py-0.5 text-xs font-medium text-base-content">
                    {summaries.length} version{summaries.length > 1 ? "s" : ""}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => setShowSummaryModal(true)}
                disabled={summaryGenerating || hasNoAudio}
                className="btn btn-primary btn-sm inline-flex items-center gap-2 px-3.5 disabled:cursor-not-allowed min-h-11"
                title={hasNoAudio ? "Summaries need meeting audio first" : summaryGenerating ? "Summary generation already in progress" : undefined}
              >
                <span>+</span>
                <span>Generate Summary</span>
              </button>
            </div>

            {/* In-flight summary generation placeholder / error */}
            {summaryGeneration?.stage === "error" ? (
              <div className="rounded-xl border border-error/30 bg-error/10 p-4 text-sm text-error ">
                <span className="font-semibold">Summary generation failed:</span> {summaryGeneration.error}
              </div>
            ) : summaryGenerating ? (
              <div className="rounded-xl border border-primary/30 bg-base-200/70 shadow-lg overflow-hidden ">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-base-300 bg-base-100/60 p-2">
                  <div className="flex items-center gap-2 text-xs">
                    <svg className="h-3.5 w-3.5 animate-spin text-primary" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                    </svg>
                    <span className="font-semibold text-base-content">
                      Generating summary
                      {summaryGeneration.provider && summaryGeneration.model
                        ? ` with ${summaryGeneration.provider}:${summaryGeneration.model}`
                        : summaryGeneration.provider
                        ? ` with ${summaryGeneration.provider}`
                        : ""}
                      …
                    </span>
                  </div>
                  <span className="text-[11px] text-base-content/50 font-mono">This can take a minute</span>
                </div>
                <div className="p-6 space-y-3">
                  <div className="h-5 w-2/5 skeleton" />
                  <div className="h-3 w-full skeleton" />
                  <div className="h-3 w-11/12 skeleton" />
                  <div className="h-3 w-4/5 skeleton" />
                  <div className="pt-3 h-4 w-1/3 skeleton" />
                  <div className="h-3 w-full skeleton" />
                  <div className="h-3 w-5/6 skeleton" />
                  <div className="h-3 w-3/5 skeleton" />
                </div>
              </div>
            ) : null}

            {summaries.length > 0 ? (
              <div className="rounded-xl border border-base-300 bg-base-200/70 shadow-lg overflow-hidden">
                {/* Summary Tabs Header */}
                <div className="flex items-center gap-2 border-b border-base-300 bg-base-100/60 p-2 overflow-x-auto">
                  {summaries.map((s, idx) => {
                    const parts = s.provider.split(":");
                    const label = parts[2] || parts[1] || `Summary ${idx + 1}`;
                    const isSelected = (activeSummary && activeSummary.id === s.id) || (!activeSummary && idx === 0);
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => setSelectedSummaryId(s.id)}
                        className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium transition whitespace-nowrap ${
                          isSelected
                            ? "bg-base-300 text-primary shadow border border-base-300"
                            : "text-base-content/70 hover:text-base-content hover:bg-base-200"
                        }`}
                      >
                        <span>{label}</span>
                        {s.isPrimary && (
                          <span className="rounded bg-primary/20 px-1.5 py-0.2 text-[10px] text-primary font-bold">
                            <Star className="h-4 w-4 shrink-0" aria-hidden="true" /> Primary
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>

                {/* Active Summary Content */}
                {activeSummary && (
                  <div className="p-6 space-y-4">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between border-b border-base-300/80 pb-3">
                      <div className="flex items-center gap-2 text-xs text-base-content/70">
                        <span className="font-mono text-base-content">{activeSummary.provider}</span>
                        <span>•</span>
                        <span>{formatDate(activeSummary.createdAt)}</span>
                        {activeSummary.isPrimary && (
                          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary border border-primary/20">
                            Primary Note
                          </span>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        {/* Rendered vs Raw view toggle */}
                        <div className="tabs tabs-box tabs-xs" role="tablist" aria-label="Summary view">
                          <button
                            type="button"
                            role="tab"
                            aria-selected={summaryViewMode === "rendered"}
                            onClick={() => setSummaryViewMode("rendered")}
                            className={`tab ${summaryViewMode === "rendered" ? "tab-active" : ""}`}
                          >
                            <Eye className="h-4 w-4 shrink-0" aria-hidden="true" /> Preview
                          </button>
                          <button
                            type="button"
                            role="tab"
                            aria-selected={summaryViewMode === "raw"}
                            onClick={() => setSummaryViewMode("raw")}
                            className={`tab ${summaryViewMode === "raw" ? "tab-active" : ""}`}
                          >
                            <FileText className="h-4 w-4 shrink-0" aria-hidden="true" /> Raw
                          </button>
                        </div>

                        {!activeSummary.isPrimary && (
                          <button
                            type="button"
                            onClick={() => void handleSetPrimarySummary(activeSummary.id)}
                            className="btn btn-primary btn-soft btn-xs min-h-11"
                          >
                            <Star className="h-4 w-4 shrink-0" aria-hidden="true" /> Set as Primary
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleCopySummary(activeSummary.content)}
                          className="btn btn-xs min-h-11"
                        >
                          {copied ? <><Check className="h-4 w-4 shrink-0" aria-hidden="true" /> Copied!</> : <><ClipboardList className="h-4 w-4 shrink-0" aria-hidden="true" /> Copy Markdown</>}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDeleteSummary(activeSummary.id)}
                          className="btn btn-error btn-soft btn-xs min-h-11"
                        >
                          Delete
                        </button>
                      </div>
                    </div>

                    {summaryViewMode === "rendered" ? (
                      <MarkdownRenderer content={activeSummary.content} />
                    ) : (
                      <pre className="whitespace-pre-wrap font-mono text-xs text-base-content rounded-xl border border-base-300 bg-base-100/80 p-4 overflow-x-auto leading-relaxed">
                        {activeSummary.content}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            ) : !summaryGenerating ? (
              <div className="rounded-xl border border-dashed border-base-300 bg-base-200/40 p-8 text-center space-y-3">
                <p className="text-sm text-base-content/70">
                  No summary generated yet. Create AI meeting notes using a custom or built-in template.
                </p>
                <button
                  type="button"
                  onClick={() => setShowSummaryModal(true)}
                  className="btn btn-primary btn-sm inline-flex items-center gap-2 min-h-11"
                >
                  <span>+</span>
                  <span>Generate Summary</span>
                </button>
              </div>
            ) : null}
          </section>

          {/* Transcript Viewer */}
          <section className={`space-y-4 w-full max-w-full min-w-0 ${activeSection !== "transcript" ? "hidden lg:block" : ""}`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-xl font-semibold tracking-tight">Transcript</h2>
              {parsedTranscriptSegments.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowRapidEnroll(true)}
                  className="btn btn-primary btn-soft inline-flex min-h-[44px] items-center gap-1.5 border"
                  title="Enroll voiceprints for unmatched or unverified speakers in this meeting"
                >
                  <span><Zap className="h-4 w-4 shrink-0" aria-hidden="true" /></span>
                  <span>Rapid enroll</span>
                </button>
              )}
              {confirmationNotice && (
                <div className="rounded-lg border border-primary/40 bg-primary/10 px-3 py-1 text-xs font-medium text-primary ">
                  {confirmationNotice}
                </div>
              )}
            </div>

            {parsedTranscriptSegments.length > 0 ? (
              <div className="space-y-3 sm:space-y-4 rounded-xl border border-base-300 bg-base-200/60 p-3 sm:p-6 w-full max-w-full min-w-0">
                {parsedTranscriptSegments.map((seg, idx) => (
                  <div
                    key={idx}
                    className="group relative rounded-xl border border-base-300/70 bg-base-200/40 p-3 sm:p-4 transition hover:border-base-300 hover:bg-base-200/80 space-y-2 w-full max-w-full min-w-0"
                  >
                    {idx > 0 && splitAllowedAt(seg.startMs) && (
                      <div className="absolute -top-3 left-0 right-0 z-10 flex justify-center opacity-0 transition group-hover:opacity-100 hover:opacity-100 focus-within:opacity-100">
                        <button
                          type="button"
                          onClick={() => {
                            setSplitMs(seg.startMs);
                            setShowSplitConfirm(true);
                          }}
                          title={`Split meeting before this turn (${formatTimeOffset(seg.startMs)})`}
                          className="inline-flex items-center gap-1 rounded-full border border-base-300 bg-base-100 px-2.5 py-0.5 text-[11px] font-medium text-base-content/50 shadow-lg transition hover:border-primary/50 hover:text-primary"
                        >
                          <Scissors className="h-4 w-4 shrink-0" aria-hidden="true" /> Split meeting here · {formatTimeOffset(seg.startMs)}
                        </button>
                      </div>
                    )}
                    {/* Header: Play/Timestamp + Speaker Badge + Action Buttons */}
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-base-300/50 pb-2">
                      <div className="flex flex-wrap items-center gap-2 min-w-0">
                        {/* Play / Timestamp button */}
                        <button
                          type="button"
                          onClick={() => handlePlaySegment(seg, idx)}
                          title={playingSegmentIndex === idx ? "Pause playback" : "Play only this turn"}
                          className={`inline-flex min-h-[40px] items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-mono transition cursor-pointer shrink-0 ${
                            playingSegmentIndex === idx
                              ? "bg-primary/20 text-primary font-bold border border-primary/40 shadow-sm"
                              : "bg-base-300/90 text-base-content/70 hover:text-primary hover:bg-base-300 border border-base-300/70"
                          }`}
                        >
                          <span className="text-[10px] inline-flex">{playingSegmentIndex === idx ? <Pause className="h-3 w-3 shrink-0" aria-hidden="true" /> : <Play className="h-3 w-3 shrink-0" aria-hidden="true" />}</span>
                          <span>{formatTimeOffset(seg.startMs)}</span>
                        </button>

                        {/* Speaker Badge */}
                        {seg.verified ? (
                          <span
                            className="inline-flex items-center gap-1 rounded-md bg-primary/20 px-2 py-0.5 text-xs font-semibold text-primary border border-primary/40 truncate max-w-[180px] sm:max-w-none"
                            title="Speaker verified & voiceprint trained"
                          >
                            <span><Check className="h-4 w-4 shrink-0" aria-hidden="true" /></span>
                            <span className="truncate">{seg.speaker}</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-md bg-base-300 px-2 py-0.5 text-xs font-semibold text-base-content border border-base-300 truncate max-w-[180px] sm:max-w-none">
                            <span className="truncate">{seg.speaker}</span>
                          </span>
                        )}
                      </div>

                      {/* Turn actions menu */}
                      <SegmentActionsMenu
                        showConfirm={!seg.verified && !isGenericSpeakerLabel(seg.speaker)}
                        showMerge={idx < parsedTranscriptSegments.length - 1}
                        showWrong={seg.speaker !== "Unknown"}
                        onConfirm={() => void handleConfirmSegment(seg.segmentIndex)}
                        onChange={() => setReassigningSpeaker({ speaker: seg.speaker, segmentIndex: seg.segmentIndex })}
                        onSplit={() => setSplittingSegment(seg)}
                        onMerge={() => void handleMergeWithNext(seg.segmentIndex)}
                        onWrong={() => void handleUnassignSegment(seg.segmentIndex)}
                      />
                    </div>

                    {/* Turn Content */}
                    <p className="text-sm leading-relaxed text-base-content pl-0.5 break-words">{seg.text}</p>
                  </div>
                ))}
              </div>
            ) : detail.transcriptContent ? (
              <pre className="whitespace-pre-wrap rounded-xl border border-base-300 bg-base-200/60 p-4 sm:p-6 text-sm font-sans text-base-content break-words overflow-x-auto">
                {detail.transcriptContent}
              </pre>
            ) : (
              <div className="rounded-xl border border-dashed border-base-300 bg-base-200/40 p-8 text-center text-base-content/70">
                No transcript generated yet. Click "Transcribe" above to generate a transcript.
              </div>
            )}
          </section>

          {/* Generate Summary Modal */}
          {showSummaryModal && (
            <GenerateSummaryModal
              meetingId={meetingId}
              onClose={() => setShowSummaryModal(false)}
              onStarted={(status) => {
                setShowSummaryModal(false);
                setSummaryGeneration(status);
              }}
            />
          )}

          {/* Chat renders in the App-level drawer. Report the title up for its header. */}
          <ChatTitleReporter title={detail.meeting.title} onChatTitle={onChatTitle} />

          {/* Split Segment Modal */}
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

          {/* Split Meeting Confirm Modal */}
          {showSplitConfirm && splitMs !== null && splitTotalMs !== null && (
            <Modal onClose={() => setShowSplitConfirm(false)} title="Split meeting in two" ariaLabel="Split meeting confirmation" maxWidth="max-w-md">
              <div className="space-y-4">
                <p className="text-sm text-base-content">
                  Split at <span className="font-mono font-semibold text-base-content">{formatTimeOffset(splitMs)}</span>? The
                  transcript is divided on the same boundary — no re-transcription needed.
                </p>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-lg border border-base-300 bg-base-200 p-3">
                    <p className="font-semibold text-base-content">Part 1 (this meeting)</p>
                    <p className="mt-1 font-mono text-base-content/70">00:00 → {formatTimeOffset(splitMs)}</p>
                  </div>
                  <div className="rounded-lg border border-base-300 bg-base-200 p-3">
                    <p className="font-semibold text-base-content">Part 2 (new meeting)</p>
                    <p className="mt-1 font-mono text-base-content/70">{formatTimeOffset(splitMs)} → {formatTimeOffset(splitTotalMs)}</p>
                  </div>
                </div>
                <p className="text-xs text-warning/90">
                  Summaries on both parts are deleted (they described the whole recording). Delete the unwanted half
                  afterwards if you only want one.
                </p>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setShowSplitConfirm(false)}
                    disabled={splittingMeeting}
                    className="rounded-lg border border-base-300 px-3.5 py-2 text-sm text-base-content hover:border-base-300 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void confirmSplitMeeting()}
                    disabled={splittingMeeting || !splitValid}
                    className="btn btn-primary px-3.5 min-h-11"
                  >
                    {splittingMeeting ? "Splitting…" : "Split meeting"}
                  </button>
                </div>
              </div>
            </Modal>
          )}

          {/* Rapid Enroll Modal */}
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

          {/* Reassign Speaker Modal */}
          {reassigningSpeaker && (
            <ReassignSpeakerModal
              meetingId={meetingId}
              fromLabel={reassigningSpeaker.speaker}
              segmentIndex={reassigningSpeaker.segmentIndex}
              knownSpeakers={knownSpeakers}
              onClose={() => setReassigningSpeaker(null)}
              onSuccess={(optimistic) => {
                const prevLabel = reassigningSpeaker.speaker;
                setReassigningSpeaker(null);
                if (optimistic && detail?.transcriptContent) {
                  try {
                    const parsed = JSON.parse(detail.transcriptContent);
                    const targetArray = Array.isArray(parsed.segments)
                      ? parsed.segments
                      : Array.isArray(parsed)
                      ? parsed
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
                      setDetail((prev) => (prev ? { ...prev, transcriptContent: JSON.stringify(parsed) } : prev));
                    }
                  } catch {}
                }
              }}
              onSettled={() => {
                void fetchDetail();
                onSpeakerUpdated();
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}
