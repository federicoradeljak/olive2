import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { ArrowRight } from "lucide-react";
import { Combobox } from "../../components/Combobox";
import { Button, Modal, notify } from "../../components/ui";
import type { SpeakerWithStats } from "../../lib/common";
import { Avatar, MAX_VOICE_SAMPLES, postJson, requestJson } from "./peopleUtils";
import type { SpeakerDetailResponse } from "./peopleUtils";

/* Merge one person into another with a preview of what moves. The backend
   re-links the source's meetings to the target, unions voiceprints and voice
   samples (capped at 8, keeping the target's first clip) and deletes the
   source. */
export function MergeDialog({
  source,
  sourceMeetingIds,
  speakers,
  onClose,
  onMerged,
}: {
  source: SpeakerWithStats;
  sourceMeetingIds: string[] | null;
  speakers: SpeakerWithStats[];
  onClose: () => void;
  onMerged: (targetId: string) => void;
}): ReactElement {
  const [targetId, setTargetId] = useState("");
  const [targetMeetingIds, setTargetMeetingIds] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const target = speakers.find((s) => s.id === targetId) ?? null;

  useEffect(() => {
    setTargetMeetingIds(null);
    if (!targetId) return;
    let cancelled = false;
    requestJson<SpeakerDetailResponse>(`/api/speakers/${targetId}`)
      .then((data) => {
        if (!cancelled) setTargetMeetingIds(data.meetings.map((m) => m.id));
      })
      .catch(() => {
        if (!cancelled) setTargetMeetingIds([]);
      });
    return () => {
      cancelled = true;
    };
  }, [targetId]);

  const preview = useMemo(() => {
    if (!target) return null;
    const srcClips = source.enrollmentClipPaths?.length ?? 0;
    const tgtClips = target.enrollmentClipPaths?.length ?? 0;
    const combinedClips = new Set([...(target.enrollmentClipPaths ?? []), ...(source.enrollmentClipPaths ?? [])]).size;
    const keptClips = Math.min(MAX_VOICE_SAMPLES, combinedClips);
    let movedMeetings: number | null = null;
    let sharedMeetings: number | null = null;
    if (sourceMeetingIds && targetMeetingIds) {
      const tgt = new Set(targetMeetingIds);
      sharedMeetings = sourceMeetingIds.filter((id) => tgt.has(id)).length;
      movedMeetings = sourceMeetingIds.length - sharedMeetings;
    }
    return { srcClips, tgtClips, keptClips, dropped: combinedClips - keptClips, movedMeetings, sharedMeetings };
  }, [source, target, sourceMeetingIds, targetMeetingIds]);

  const handleMerge = async () => {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await postJson("/api/speakers/merge", { sourceSpeakerId: source.id, targetSpeakerId: target.id });
      notify("success", `Merged ${source.name} into ${target.name}`);
      onMerged(target.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} title={`Merge ${source.name} into…`} ariaLabel={`Merge ${source.name}`} maxWidth="max-w-lg">
      <div className="space-y-4 text-sm">
        <p className="text-base-content/70">
          Use this when the same person was saved twice. Everything moves to the person you pick, and {source.name} is removed.
        </p>
        <Combobox
          value={targetId}
          onChange={setTargetId}
          placeholder="Choose a person…"
          ariaLabel={`Merge ${source.name} into`}
          searchPlaceholder="Search people…"
          emptyText="No people match your search."
          options={speakers
            .filter((s) => s.id !== source.id)
            .map((s) => ({ value: s.id, label: s.name, description: `${s.meetingCount} meeting${s.meetingCount === 1 ? "" : "s"}` }))}
        />

        {target && preview && (
          <div className="space-y-3 rounded-lg border border-divider p-4">
            <div className="flex items-center gap-2 font-medium">
              <Avatar speaker={source} />
              <span className="min-w-0 truncate">{source.name}</span>
              <ArrowRight className="h-4 w-4 shrink-0 text-base-content/50" aria-hidden="true" />
              <Avatar speaker={target} />
              <span className="min-w-0 truncate">{target.name}</span>
            </div>
            <ul className="list-disc space-y-1 pl-5 text-base-content/80">
              <li>
                {preview.movedMeetings === null
                  ? `${source.meetingCount} meeting${source.meetingCount === 1 ? "" : "s"} will list ${target.name} instead`
                  : `${preview.movedMeetings} meeting${preview.movedMeetings === 1 ? "" : "s"} will list ${target.name} instead${
                      preview.sharedMeetings ? ` (${preview.sharedMeetings} already shared)` : ""
                    }`}
              </li>
              <li>
                Voice samples: {preview.tgtClips} + {preview.srcClips}, keeping {preview.keptClips} of {MAX_VOICE_SAMPLES}
                {preview.dropped > 0 ? ` (the ${preview.dropped} oldest extra${preview.dropped === 1 ? " is" : "s are"} discarded)` : ""}
              </li>
              <li>Voiceprints are combined so {target.name} is recognized from both</li>
              <li className="text-error">{source.name} is deleted. This cannot be undone.</li>
            </ul>
          </div>
        )}

        {error && <div className="alert alert-soft alert-error text-sm">{error}</div>}

        <div className="flex justify-end gap-2 border-t border-divider pt-4">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void handleMerge()} disabled={!target || busy}>
            {busy && <span className="loading loading-spinner loading-xs" aria-hidden="true" />}
            {target ? `Merge into ${target.name}` : "Merge"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
