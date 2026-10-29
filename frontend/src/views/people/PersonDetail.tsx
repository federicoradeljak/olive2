import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { ArrowLeft, AudioLines, Check, Pencil, RefreshCw, Sparkles, Trash2, X } from "lucide-react";
import { confirmAction, notify } from "../../components/ui";
import type { SpeakerWithStats } from "../../lib/common";
import { ActionMenu } from "./ActionMenu";
import { MergeDialog } from "./MergeDialog";
import {
  Avatar,
  MAX_VOICE_SAMPLES,
  hasVoice,
  parseClipSource,
  postJson,
  requestJson,
  shortDate,
  voiceSampleCount,
} from "./peopleUtils";
import type { SpeakerDetailResponse, SpeakerMeetingLink } from "./peopleUtils";

export function PersonDetail({
  speaker,
  speakers,
  onRefresh,
  onSelectMeeting,
  onBack,
  onRemoved,
}: {
  speaker: SpeakerWithStats;
  speakers: SpeakerWithStats[];
  onRefresh: () => void;
  onSelectMeeting: (meetingId: string) => void;
  onBack: () => void;
  onRemoved: (nextSelectedId: string | null) => void;
}): ReactElement {
  const [meetings, setMeetings] = useState<SpeakerMeetingLink[] | null>(null);
  const [meetingsError, setMeetingsError] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(speaker.name);
  const [savingName, setSavingName] = useState(false);
  const [merging, setMerging] = useState(false);
  const [working, setWorking] = useState<string | null>(null);

  // Reload the meeting list whenever the person or their stats change
  // (rename, merge into them, new samples learned elsewhere).
  useEffect(() => {
    let cancelled = false;
    setMeetingsError(false);
    requestJson<SpeakerDetailResponse>(`/api/speakers/${speaker.id}`)
      .then((data) => {
        if (!cancelled) setMeetings(data.meetings);
      })
      .catch(() => {
        if (!cancelled) {
          setMeetings([]);
          setMeetingsError(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [speaker.id, speaker.meetingCount]);

  // The parent keys this component by person id, so only renames land here.
  useEffect(() => {
    setEditing(false);
    setDraftName(speaker.name);
  }, [speaker.name]);

  const samples = voiceSampleCount(speaker);
  const clips = speaker.enrollmentClipPaths ?? [];
  const voiced = hasVoice(speaker);
  const hasSm = (speaker.providerIds?.speechmatics?.length ?? 0) > 0;
  const firstName = speaker.name.split(/\s+/)[0] || speaker.name;
  const meetingTitles = new Map((meetings ?? []).map((m) => [m.id, m.title]));

  const saveName = async () => {
    const name = draftName.trim();
    if (!name || name === speaker.name) {
      setEditing(false);
      setDraftName(speaker.name);
      return;
    }
    setSavingName(true);
    try {
      await requestJson(`/api/speakers/${speaker.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      setEditing(false);
      onRefresh();
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Failed to rename person");
    } finally {
      setSavingName(false);
    }
  };

  const runVoiceAction = async (kind: "rebuild" | "relearn") => {
    setWorking(kind);
    try {
      const res = await postJson<{ updated?: number; cleanedClipsCount?: number }>(
        `/api/speakers/${speaker.id}/${kind === "rebuild" ? "rebuild" : "backfill"}`,
        kind === "relearn" ? { force: true } : {},
      );
      notify(
        "success",
        kind === "rebuild"
          ? `Voiceprint rebuilt for ${speaker.name}${res.cleanedClipsCount ? ` (${res.cleanedClipsCount} unusable sample${res.cleanedClipsCount === 1 ? "" : "s"} removed)` : ""}`
          : res.updated
            ? `Voiceprint re-learned from ${speaker.name}'s samples`
            : `No stored samples to learn from for ${speaker.name}`,
      );
      onRefresh();
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Voiceprint update failed");
    } finally {
      setWorking(null);
    }
  };

  const handleDelete = async () => {
    const n = speaker.meetingCount;
    const ok = await confirmAction({
      title: `Delete ${speaker.name}?`,
      message: `${speaker.name} is removed from People and from the participant list of ${n} meeting${n === 1 ? "" : "s"}. Their voiceprint and ${samples} voice sample${samples === 1 ? "" : "s"} are discarded, so Olive stops recognizing them. Transcript text is not changed. This cannot be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await requestJson(`/api/speakers/${speaker.id}`, { method: "DELETE" });
      notify("success", `Deleted ${speaker.name}`);
      onRemoved(null);
      onRefresh();
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Failed to delete person");
    }
  };

  return (
    <article className="flex min-w-0 flex-col gap-7">
      <button
        type="button"
        onClick={onBack}
        className="-ml-2 inline-flex min-h-11 items-center gap-1.5 self-start rounded-md px-2 text-sm text-base-content/60 hover:bg-hover hover:text-base-content lg:hidden"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        People
      </button>

      <header className="flex flex-wrap items-center gap-4 sm:gap-5">
        <Avatar speaker={speaker} size="lg" />
        <div className="flex min-w-0 flex-1 basis-56 flex-col gap-1">
          {editing ? (
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                void saveName();
              }}
            >
              <input
                autoFocus
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setEditing(false);
                    setDraftName(speaker.name);
                  }
                }}
                aria-label="Name"
                disabled={savingName}
                className="input input-ghost min-w-0 flex-1 px-1 text-2xl font-bold tracking-tight sm:text-3xl"
              />
              <button type="submit" aria-label="Save name" disabled={savingName} className="btn btn-ghost btn-square min-h-11 min-w-11">
                <Check className="h-4 w-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label="Cancel rename"
                onClick={() => {
                  setEditing(false);
                  setDraftName(speaker.name);
                }}
                className="btn btn-ghost btn-square min-h-11 min-w-11"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </form>
          ) : (
            <h2 className="group flex min-w-0 items-center gap-1 text-2xl font-bold tracking-tight sm:text-[32px] sm:leading-tight">
              <button
                type="button"
                onClick={() => setEditing(true)}
                title="Rename"
                className="min-w-0 truncate rounded-md px-1 -mx-1 text-left hover:bg-hover"
              >
                {speaker.name}
              </button>
              <button
                type="button"
                onClick={() => setEditing(true)}
                aria-label={`Rename ${speaker.name}`}
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-base-content/40 hover:bg-hover hover:text-base-content lg:h-8 lg:w-8 lg:opacity-0 lg:group-hover:opacity-100 lg:focus:opacity-100"
              >
                <Pencil className="h-4 w-4" aria-hidden="true" />
              </button>
            </h2>
          )}
          <span className="flex flex-wrap items-center gap-2 text-sm text-base-content/60">
            {voiced ? "Recognized automatically in new meetings" : "No voice yet. Assign them in a transcript to teach Olive their voice."}
            {hasSm && <span className="tag tag-blue">Speechmatics voiceprint</span>}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setMerging(true)}
            disabled={speakers.length < 2}
            className="btn btn-sm min-h-11 border-base-300 bg-transparent font-normal shadow-none hover:bg-hover lg:min-h-8"
          >
            Merge into…
          </button>
          <ActionMenu
            label={`More actions for ${speaker.name}`}
            buttonClassName="border border-base-300"
            items={[
              {
                label: working === "rebuild" ? "Rebuilding…" : "Rebuild voiceprint",
                description: "Drops duplicate or unusable samples and recomputes",
                icon: <RefreshCw className="h-4 w-4" aria-hidden="true" />,
                disabled: working !== null || clips.length === 0,
                onSelect: () => void runVoiceAction("rebuild"),
              },
              {
                label: working === "relearn" ? "Re-learning…" : "Re-learn from samples",
                description: "Recomputes the voiceprint from the stored samples as they are",
                icon: <Sparkles className="h-4 w-4" aria-hidden="true" />,
                disabled: working !== null || clips.length === 0,
                onSelect: () => void runVoiceAction("relearn"),
              },
              "divider",
              {
                label: "Delete…",
                icon: <Trash2 className="h-4 w-4" aria-hidden="true" />,
                danger: true,
                onSelect: () => void handleDelete(),
              },
            ]}
          />
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Voice samples" value={`${samples} of ${MAX_VOICE_SAMPLES}`} />
        <Stat label="Meetings" value={String(speaker.meetingCount)} />
        <Stat label="Last learned" value={speaker.enrolledAt ? shortDate(speaker.enrolledAt) : "Never"} />
        <Stat label="Added" value={shortDate(speaker.createdAt)} />
      </div>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 className="text-lg font-semibold">Voice samples</h3>
          <span className="text-sm text-base-content/60">
            Olive keeps the {MAX_VOICE_SAMPLES} clearest clips and replaces the oldest when it learns a better one.
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {Array.from({ length: MAX_VOICE_SAMPLES }, (_, i) => {
            const clip = clips[i];
            const filled = i < samples;
            if (!filled) {
              return (
                <div key={i} className="flex min-h-24 items-center justify-center rounded-xl border border-dashed border-base-300 p-3 text-xs text-base-content/50">
                  Empty slot
                </div>
              );
            }
            const src = clip ? parseClipSource(clip) : null;
            const fromMeeting = src?.meetingId ? meetingTitles.get(src.meetingId) : undefined;
            return (
              <div key={clip ?? `v${i}`} className="flex min-h-24 flex-col justify-between gap-2 rounded-xl border border-base-300 p-3">
                <span className="flex items-center gap-2 text-base-content/60">
                  <AudioLines className="h-4 w-4 shrink-0" aria-hidden="true" />
                  {i === 0 && clip && <span className="tag text-xs" title="The first sample is kept as an anchor and never replaced">Anchor</span>}
                </span>
                <span className="text-xs text-base-content/60">
                  {!clip ? (
                    "Imported voiceprint"
                  ) : src?.meetingId && fromMeeting ? (
                    <button
                      type="button"
                      onClick={() => onSelectMeeting(src.meetingId!)}
                      className="line-clamp-2 text-left hover:text-base-content hover:underline"
                    >
                      {fromMeeting}
                    </button>
                  ) : (
                    <span className="line-clamp-2">From a meeting</span>
                  )}
                  {src?.learnedAt ? <span className="block">{shortDate(src.learnedAt)}</span> : null}
                </span>
              </div>
            );
          })}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-lg font-semibold">Meetings with {firstName}</h3>
        {meetings === null ? (
          <div className="py-6 text-sm text-base-content/50">Loading meetings…</div>
        ) : meetingsError ? (
          <div className="py-6 text-sm text-error">Could not load meetings.</div>
        ) : meetings.length === 0 ? (
          <div className="py-6 text-sm text-base-content/50">Not linked to any meeting yet.</div>
        ) : (
          <ul className="border-t border-divider">
            {meetings.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => onSelectMeeting(m.id)}
                  className="flex min-h-11 w-full items-center gap-3 border-b border-divider px-2 text-left hover:bg-hover"
                >
                  <span className="min-w-0 flex-1 truncate font-medium">{m.title}</span>
                  <span className="shrink-0 text-sm text-base-content/60">{shortDate(m.startTime)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {merging && (
        <MergeDialog
          source={speaker}
          sourceMeetingIds={meetings ? meetings.map((m) => m.id) : null}
          speakers={speakers}
          onClose={() => setMerging(false)}
          onMerged={(targetId) => {
            setMerging(false);
            onRemoved(targetId);
            onRefresh();
          }}
        />
      )}
    </article>
  );
}

function Stat({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="flex flex-col gap-0.5 rounded-xl bg-base-200 p-3.5">
      <span className="text-sm text-base-content/60">{label}</span>
      <span className="text-xl font-semibold sm:text-[22px]">{value}</span>
    </div>
  );
}
