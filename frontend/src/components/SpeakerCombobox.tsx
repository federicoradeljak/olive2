import type { ReactElement } from "react";
import { CircleDashed, Cloud, Fingerprint, UserPlus } from "lucide-react";
import { Combobox } from "./Combobox";
import type { Speaker } from "../api/types";

export function isSpeakerEnrolled(speaker: Pick<Speaker, "providerIds">): boolean {
  return (
    (speaker.providerIds.speechmatics?.length ?? 0) > 0 ||
    (speaker.providerIds.local?.length ?? 0) > 0
  );
}

/** Lucide status mark: Fingerprint when a voiceprint exists, dashed circle when discovered-only. */
export function SpeakerStatusIcon({ speaker }: { speaker: Pick<Speaker, "providerIds"> }): ReactElement {
  const enrolled = isSpeakerEnrolled(speaker);
  return enrolled ? (
    <Fingerprint
      className="h-3.5 w-3.5 shrink-0 text-lime-300"
      aria-label="Voiceprint enrolled"
      role="img"
    />
  ) : (
    <CircleDashed
      className="h-3.5 w-3.5 shrink-0 text-stone-500"
      aria-label="Discovered, no voiceprint"
      role="img"
    />
  );
}

/**
 * Searchable person picker (replaces native <select> so each row can carry a
 * Lucide voiceprint status icon + enrollment detail).
 */
export function SpeakerCombobox({
  value,
  onChange,
  knownSpeakers,
  emptyLabel = "-- Who is this? --",
  createLabel = "+ Create new person",
  showCreateOption = true,
  placeholder = "Select person…",
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  knownSpeakers: Pick<Speaker, "id" | "name" | "providerIds" | "enrollmentClipPaths">[];
  emptyLabel?: string;
  createLabel?: string;
  showCreateOption?: boolean;
  placeholder?: string;
  ariaLabel?: string;
}): ReactElement {
  return (
    <Combobox
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      ariaLabel={ariaLabel ?? placeholder}
      searchPlaceholder="Search people…"
      emptyText="No people match your search."
      options={[
        { value: "", label: emptyLabel },
        ...(showCreateOption
          ? [
              {
                value: "new",
                label: createLabel,
                icon: <UserPlus className="h-3.5 w-3.5 shrink-0 text-lime-300" aria-hidden="true" />,
              },
            ]
          : []),
        ...knownSpeakers.map((s) => {
          const enrolled = isSpeakerEnrolled(s);
          const clips = s.enrollmentClipPaths?.length ?? 0;
          return {
            value: s.id,
            label: s.name,
            description: enrolled
              ? clips > 0
                ? `Voiceprint enrolled · ${clips}/8 clips`
                : "Voiceprint enrolled"
              : "Discovered · no voiceprint yet",
            keywords: enrolled ? "enrolled voiceprint fingerprint" : "discovered new",
            icon: <SpeakerStatusIcon speaker={s} />,
          };
        }),
      ]}
    />
  );
}

/** Compact icon badges for the People cards (replaces "Enrolled (x/8)" / "Discovered" pills). */
export function SpeakerStatusBadges({
  speaker,
}: {
  speaker: Pick<Speaker, "providerIds" | "enrollmentClipPaths">;
}): ReactElement {
  const hasLocalVoiceprint = (speaker.providerIds.local?.length ?? 0) > 0;
  const hasSmVoiceprint = (speaker.providerIds.speechmatics?.length ?? 0) > 0;
  const clips = speaker.enrollmentClipPaths?.length ?? 0;

  if (!hasLocalVoiceprint && !hasSmVoiceprint) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full border border-stone-700 bg-stone-800 px-2 py-0.5 text-[10px] font-medium text-stone-400"
        title="Discovered — no voiceprint enrolled yet"
      >
        <CircleDashed className="h-3 w-3" aria-hidden="true" />
        <span className="sr-only">Discovered — no voiceprint enrolled yet</span>
        <span aria-hidden="true">New</span>
      </span>
    );
  }

  return (
    <>
      {hasLocalVoiceprint && (
        <span
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
            clips >= 8
              ? "border-lime-400/40 bg-lime-400/20 font-semibold text-lime-300"
              : clips >= 5
                ? "border-lime-400/30 bg-lime-400/15 text-lime-300"
                : "border-lime-400/20 bg-lime-400/10 text-lime-400"
          }`}
          title={
            clips >= 8
              ? "Profile optimal (8/8 clips enrolled with anchor protection)"
              : `${clips || 1}/8 voiceprint clips enrolled`
          }
        >
          <Fingerprint className="h-3 w-3" aria-hidden="true" />
          <span className="sr-only">
            {clips >= 8
              ? "Voiceprint enrolled, profile optimal (8/8)"
              : `Voiceprint enrolled (${clips || 1}/8 clips)`}
          </span>
          <span aria-hidden="true">{clips >= 8 ? "8/8" : `${clips || 1}/8`}</span>
        </span>
      )}
      {hasSmVoiceprint && (
        <span
          className="inline-flex items-center gap-1 rounded-full border border-blue-400/20 bg-blue-400/10 px-2 py-0.5 text-[10px] font-medium text-blue-300"
          title="Speechmatics voiceprint active"
        >
          <Cloud className="h-3 w-3" aria-hidden="true" />
          <span className="sr-only">Speechmatics voiceprint active</span>
          <span aria-hidden="true">SM</span>
        </span>
      )}
    </>
  );
}
