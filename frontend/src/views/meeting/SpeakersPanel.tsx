import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { Ellipsis, Pencil, RotateCw } from "lucide-react";
import type { RapidEnrollCandidateGroup, SpeakerReidentificationStatus } from "../../api/types.ts";
import { notify } from "../../components/ui";
import { SpeakerCombobox, isSpeakerEnrolled } from "../../components/SpeakerCombobox";
import { SpeakerWithStats } from "../../lib/common";
import { ClipRow, assignRapidEnroll, defaultSampleSelection } from "../meetingModals";
import { Menu, Spinner, speakerInitials, speakerTone } from "./kit";
import { VoiceMatchingControls } from "./VoiceMatching";
import type { SpeakerStat } from "./transcript";

/** Rapid-enroll candidates (unknown or unconfirmed voices) for this meeting. */
function useEnrollCandidates(meetingId: string, refreshKey: string | null): {
  groups: RapidEnrollCandidateGroup[] | null;
  setGroups: (fn: (prev: RapidEnrollCandidateGroup[] | null) => RapidEnrollCandidateGroup[] | null) => void;
  reload: () => void;
} {
  const [groups, setGroups] = useState<RapidEnrollCandidateGroup[] | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/meetings/${meetingId}/speakers/rapid-enroll-candidates?limit=4`)
      .then((res) => (res.ok ? res.json() : { groups: [] }))
      .then((data: { groups?: RapidEnrollCandidateGroup[] }) => {
        if (!cancelled) setGroups(data.groups ?? []);
      })
      .catch(() => {
        if (!cancelled) setGroups([]);
      });
    return () => {
      cancelled = true;
    };
  }, [meetingId, refreshKey, tick]);
  return { groups, setGroups, reload: () => setTick((t) => t + 1) };
}

export function SpeakersPanel({
  meetingId,
  stats,
  knownSpeakers,
  refreshKey,
  reidentifying,
  reidentifyStatus,
  playingSegmentIndex,
  similarity,
  clustering,
  onSimilarityChange,
  onClusteringChange,
  onReidentify,
  onChangeSpeaker,
  onOpenRapidEnroll,
  onPlaySample,
  onAssigned
}: {
  meetingId: string;
  stats: SpeakerStat[];
  knownSpeakers: SpeakerWithStats[];
  refreshKey: string | null;
  reidentifying: boolean;
  reidentifyStatus: SpeakerReidentificationStatus | null;
  playingSegmentIndex: number | null;
  similarity: number;
  clustering: number;
  onSimilarityChange: (v: number) => void;
  onClusteringChange: (v: number) => void;
  onReidentify: () => void;
  onChangeSpeaker: (label: string, segmentIndex?: number) => void;
  onOpenRapidEnroll: () => void;
  onPlaySample: (sample: { startMs: number; endMs: number; segmentIndex: number }) => void;
  onAssigned: () => void;
}): ReactElement {
  const { groups, setGroups, reload } = useEnrollCandidates(meetingId, refreshKey);
  const [focusLabel, setFocusLabel] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [target, setTarget] = useState<{ speakerId: string; customName: string }>({ speakerId: "", customName: "" });
  const whoRef = useRef<HTMLDivElement | null>(null);

  const groupByLabel = useMemo(() => new Map((groups ?? []).map((g) => [g.label, g])), [groups]);
  const unknownGroups = (groups ?? []).filter((g) => g.status === "unmatched");
  const whoGroup =
    (focusLabel ? groupByLabel.get(focusLabel) : undefined) ?? unknownGroups[0] ?? null;

  useEffect(() => {
    setTarget({ speakerId: "", customName: "" });
  }, [whoGroup?.label]);

  const knownByName = useMemo(() => new Map(knownSpeakers.map((s) => [s.name.trim().toLowerCase(), s])), [knownSpeakers]);

  const runAssign = (group: RapidEnrollCandidateGroup, toSpeakerId: string | undefined, toSpeakerName: string | undefined) => {
    const label = group.label;
    setPending((p) => ({ ...p, [label]: true }));
    setGroups((prev) => (prev ?? []).filter((g) => g.label !== label));
    if (focusLabel === label) setFocusLabel(null);
    void assignRapidEnroll(meetingId, { fromLabel: label, toSpeakerId, toSpeakerName, segmentIndices: defaultSampleSelection(group) })
      .then((data) => {
        const name = data.speaker?.name ?? toSpeakerName ?? "speaker";
        notify("success", `${label === name ? `Confirmed ${name}` : `${label} is now ${name}`} — learned from ${data.enrolledSamplesCount ?? 0} clip${data.enrolledSamplesCount === 1 ? "" : "s"}`);
        onAssigned();
      })
      .catch((err) => {
        notify("error", `Couldn't assign ${label}: ${err instanceof Error ? err.message : String(err)}`);
        reload();
      })
      .finally(() => setPending((p) => ({ ...p, [label]: false })));
  };

  const assignWho = () => {
    if (!whoGroup) return;
    if (target.speakerId && target.speakerId !== "new") {
      runAssign(whoGroup, target.speakerId, knownSpeakers.find((s) => s.id === target.speakerId)?.name);
    } else if (target.customName.trim()) {
      runAssign(whoGroup, undefined, target.customName.trim());
    } else {
      notify("warning", "Pick a person or type a new name first");
    }
  };

  const reidentifyLabel = reidentifying
    ? reidentifyStatus?.stage === "queued"
      ? "Queued…"
      : "Re-identifying…"
    : reidentifyStatus?.stage === "error"
    ? "Retry re-identify"
    : "Re-identify all";

  const whoTargetName =
    target.speakerId && target.speakerId !== "new" ? knownSpeakers.find((s) => s.id === target.speakerId)?.name : target.customName.trim();

  return (
    <div className="space-y-5 px-4 py-4 lg:px-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">Speakers</h2>
        <button
          type="button"
          onClick={onReidentify}
          disabled={reidentifying || stats.length === 0}
          title="Match every voice again against the people you've saved"
          className="btn btn-ghost btn-sm min-h-11 gap-1.5 font-normal text-base-content/60 lg:min-h-0"
        >
          <RotateCw className={`h-3.5 w-3.5 ${reidentifying ? "animate-spin" : ""}`} aria-hidden="true" />
          {reidentifyLabel}
        </button>
      </div>
      {reidentifyStatus?.stage === "error" && reidentifyStatus.error && (
        <p className="rounded-lg bg-error/10 px-3 py-2 text-xs">{reidentifyStatus.error}</p>
      )}

      {stats.length === 0 ? (
        <p className="text-sm text-base-content/50">Speakers appear here once the meeting is transcribed.</p>
      ) : (
        <ul className="space-y-1">
          {stats.map((s) => {
            const group = groupByLabel.get(s.label);
            const tone = speakerTone(s.label);
            const known = knownByName.get(s.label.trim().toLowerCase());
            const clips = known?.enrollmentClipPaths.length ?? 0;
            const isPending = pending[s.label];
            let status: string;
            let action: { label: string; run: () => void } | null = null;
            if (isPending) {
              status = "Saving…";
            } else if (group?.status === "unverified") {
              status = `Likely match · ${s.turns} turn${s.turns === 1 ? "" : "s"}`;
              action = {
                label: "Confirm",
                run: () => runAssign(group, group.speakerId ?? known?.id ?? undefined, group.speakerName ?? s.label)
              };
            } else if (group?.status === "unmatched" || s.status === "unknown") {
              status = `Unknown voice · ${s.turns} turn${s.turns === 1 ? "" : "s"}`;
              action = {
                label: "Identify",
                run: () => {
                  if (group) {
                    setFocusLabel(group.label);
                    whoRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
                  } else {
                    onChangeSpeaker(s.label, s.firstSegmentIndex);
                  }
                }
              };
            } else if (s.status === "verified") {
              status = known && isSpeakerEnrolled(known) ? `Verified · voice learned${clips ? ` from ${clips} clip${clips === 1 ? "" : "s"}` : ""}` : "Verified";
            } else {
              status = `Not confirmed · ${s.turns} turn${s.turns === 1 ? "" : "s"}`;
            }
            return (
              <li key={s.label} className="space-y-1.5 rounded-lg p-2.5 hover:bg-hover">
                <div className="flex items-center gap-2.5">
                  <span
                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
                    style={{ background: `var(--tag-${tone}-bg)`, color: `var(--tag-${tone})` }}
                    aria-hidden="true"
                  >
                    {speakerInitials(s.label)}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium">{s.label}</span>
                  <span className="text-xs text-base-content/50 tabular-nums">{Math.round(s.share * 100)}%</span>
                  <Menu
                    ariaLabel={`Actions for ${s.label}`}
                    triggerClassName="btn btn-ghost btn-square btn-xs min-h-11 min-w-11 text-base-content/50 lg:min-h-0 lg:min-w-0"
                    trigger={<Ellipsis className="h-4 w-4" aria-hidden="true" />}
                    items={[
                      {
                        key: "rename",
                        icon: <Pencil className="h-4 w-4" aria-hidden="true" />,
                        label: "Change speaker for all turns…",
                        onSelect: () => onChangeSpeaker(s.label)
                      }
                    ]}
                  />
                </div>
                <span className="block h-1 overflow-hidden rounded-full bg-active" aria-hidden="true">
                  <span className="block h-full rounded-full" style={{ width: `${Math.max(2, s.share * 100)}%`, background: `var(--tag-${tone})` }} />
                </span>
                <div className="flex min-h-7 items-center justify-between gap-2">
                  <span className="text-xs text-base-content/55">{status}</span>
                  {action && (
                    <button type="button" onClick={action.run} className="btn btn-xs h-7 min-h-11 border-base-300 bg-base-100 px-2.5 font-medium lg:min-h-0">
                      {action.label}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {groups === null && stats.length > 0 && (
        <p className="flex items-center gap-2 text-xs text-base-content/50">
          <Spinner className="h-3.5 w-3.5" /> Looking for voices to identify…
        </p>
      )}

      {whoGroup && (
        <div ref={whoRef} className="space-y-3 rounded-box border border-base-300 bg-base-100 p-3.5">
          <div>
            <p className="font-semibold">Who is “{whoGroup.label}”?</p>
            <p className="mt-0.5 text-[13px] text-base-content/60">
              Listen to the clearest clips, then pick a person. Every turn gets renamed and the voice is learned.
            </p>
          </div>
          <div className="space-y-0.5">
            {(whoGroup.samples ?? []).slice(0, 3).map((sample) => (
              <ClipRow
                key={sample.segmentIndex}
                startMs={sample.startMs}
                durationMs={sample.durationMs}
                text={sample.text}
                playing={playingSegmentIndex === sample.segmentIndex}
                onPlay={() => onPlaySample(sample)}
              />
            ))}
          </div>
          <SpeakerCombobox
            value={target.speakerId}
            onChange={(v) => setTarget((t) => ({ ...t, speakerId: v }))}
            knownSpeakers={knownSpeakers}
            emptyLabel="Choose or create a person…"
            createLabel="Create person"
            ariaLabel={`Who is ${whoGroup.label}?`}
          />
          {(target.speakerId === "new" || !target.speakerId) && (
            <input
              type="text"
              value={target.customName}
              onChange={(e) => setTarget((t) => ({ ...t, customName: e.target.value }))}
              placeholder="New person's name"
              aria-label="New person's name"
              className="input input-sm h-11 w-full lg:h-8"
            />
          )}
          <div className="flex items-center justify-between gap-2">
            <button type="button" onClick={onOpenRapidEnroll} className="btn btn-ghost btn-sm min-h-11 px-1 font-normal text-base-content/60 lg:min-h-0">
              Review all voices…
            </button>
            <button type="button" onClick={assignWho} className="btn btn-primary btn-sm min-h-11 lg:min-h-0">
              {whoTargetName ? `Assign to ${whoTargetName}` : "Assign"}
            </button>
          </div>
        </div>
      )}
      {!whoGroup && groups !== null && groups.length > 0 && (
        <button type="button" onClick={onOpenRapidEnroll} className="btn btn-sm min-h-11 w-full lg:min-h-0">
          Review voices to confirm…
        </button>
      )}

      <details className="border-t border-divider pt-3">
        <summary className="cursor-pointer text-[13px] text-base-content/60">Advanced: voice matching</summary>
        <div className="pt-3">
          <VoiceMatchingControls
            idPrefix="speakers-panel"
            similarity={similarity}
            onSimilarityChange={onSimilarityChange}
            clustering={clustering}
            onClusteringChange={onClusteringChange}
          />
        </div>
      </details>
    </div>
  );
}
