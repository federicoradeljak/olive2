import React, { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { AudioLines, Check, CircleAlert, Clock, Pause, Play, Scissors, Search, Upload } from "lucide-react";
import { Combobox } from "../components/Combobox";
import { notify } from "../components/ui";
import { SpeakerCombobox } from "../components/SpeakerCombobox";
import { ENGINE_OPTIONS, MODAL_ASR_MODEL_OPTIONS, type ModalAsrModel, SUMMARY_AUTO_LABEL, TRANSCRIPTION_AUTO_LABEL, languageOptions } from "../components/OptionComboboxes";
import type { LlmModelCatalogItem, SummaryGenerationStatus, RapidEnrollAssignResponse, RapidEnrollCandidateGroup, Template } from "../api/types.ts";
import { MeetingsResponse, SpeakerWithStats, formatDate, formatDuration, formatTimeOffset, isGenericSpeakerLabel } from "../lib/common";
import { Modal } from "./AppModals";
import { FieldLabel, ModalFooter, Segmented, Spinner } from "./meeting/kit";
import { VoiceMatchingControls } from "./meeting/VoiceMatching";

const THINKING_LABELS: Record<string, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max"
};

export function GenerateSummaryModal({
  meetingId,
  onClose,
  onStarted
}: {
  meetingId: string;
  onClose: () => void;
  onStarted: (status: SummaryGenerationStatus) => void;
}): ReactElement {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [models, setModels] = useState<LlmModelCatalogItem[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [selectedProvider, setSelectedProvider] = useState<string>("google");
  const [selectedModel, setSelectedModel] = useState<string>("gemini-2.5-flash");
  const [thinkingLevel, setThinkingLevel] = useState<string>("low");
  const [setPrimary, setSetPrimary] = useState(true);
  const [language, setLanguage] = useState("");
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const [tplRes, llmRes, configRes] = await Promise.all([
          fetch("/api/templates"),
          fetch("/api/llm/models"),
          fetch("/api/llm/config")
        ]);

        if (tplRes.ok) {
          const tData = await tplRes.json();
          const tList: Template[] = tData.templates || [];
          setTemplates(tList);
          const defaultTpl = tList.find((t) => t.isDefault) || tList[0];
          if (defaultTpl) {
            setSelectedTemplateId(defaultTpl.id);
          }
        }

        if (llmRes.ok) {
          const mData = await llmRes.json();
          setModels(mData.models || []);
        }

        if (configRes.ok) {
          const cData = await configRes.json();
          if (cData.defaultProvider) setSelectedProvider(cData.defaultProvider);
          if (cData.defaultModel) setSelectedModel(cData.defaultModel);
          if (cData.defaultThinkingLevel) setThinkingLevel(cData.defaultThinkingLevel);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, []);

  const selectedModelObj = models.find((m) => m.provider === selectedProvider && m.id === selectedModel);
  const thinkingLevels: string[] = selectedModelObj?.supportedThinkingLevels || ["low", "medium", "high"];

  const handleModelChange = (value: string) => {
    const sep = value.indexOf("::");
    if (sep < 0) return;
    const provider = value.slice(0, sep);
    const id = value.slice(sep + 2);
    setSelectedProvider(provider);
    setSelectedModel(id);
    const m = models.find((mod) => mod.provider === provider && mod.id === id);
    const supported: string[] = m?.supportedThinkingLevels || ["low", "medium", "high"];
    if (!supported.includes(thinkingLevel)) {
      setThinkingLevel(supported.includes("off") ? "off" : supported[0] || "low");
    }
  };

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    setStarting(true);
    setError(null);

    try {
      const res = await fetch(`/api/meetings/${meetingId}/summarize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateId: selectedTemplateId || undefined,
          provider: selectedProvider,
          model: selectedModel,
          thinkingLevel: selectedModelObj?.reasoning ? thinkingLevel : undefined,
          language: language || undefined,
          setPrimary
        })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      onStarted(data.status);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStarting(false);
    }
  };

  const modelChoices = useMemo(() => {
    const multipleProviders = new Set(models.map((m) => m.provider)).size > 1;
    const list = models.map((m) => ({
      value: `${m.provider}::${m.id}`,
      label: m.name,
      description: [multipleProviders ? m.provider.charAt(0).toUpperCase() + m.provider.slice(1) : null, m.reasoning ? "Reasoning" : null]
        .filter(Boolean)
        .join(" · ") || undefined,
      keywords: `${m.provider} ${m.id}`
    }));
    // Keep the configured default selectable even if the catalog lacks it.
    const current = `${selectedProvider}::${selectedModel}`;
    if (!list.some((o) => o.value === current)) list.unshift({ value: current, label: selectedModel, description: selectedProvider, keywords: "" });
    return list;
  }, [models, selectedProvider, selectedModel]);

  return (
    <Modal onClose={onClose} title="New summary" ariaLabel="New summary" maxWidth="max-w-lg">
      {error && <div className="mb-4 rounded-lg bg-error/10 p-3 text-sm text-error">{error}</div>}

      {loading ? (
        <div className="flex items-center justify-center gap-2 p-8 text-sm text-base-content/60">
          <Spinner /> Loading templates and models…
        </div>
      ) : (
        <form onSubmit={handleGenerate} className="space-y-5">
          <fieldset>
            <legend className="mb-1.5 text-[13px] font-medium text-base-content/60">Template</legend>
            {templates.length === 0 ? (
              <p className="text-sm text-base-content/60">No templates yet — the default prompt will be used.</p>
            ) : (
              <div className="max-h-72 space-y-1.5 overflow-y-auto pr-0.5">
                {templates.map((t) => {
                  const on = t.id === selectedTemplateId;
                  return (
                    <label
                      key={t.id}
                      className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition ${
                        on ? "border-primary bg-primary/10" : "border-base-300 hover:bg-hover"
                      }`}
                    >
                      <input
                        type="radio"
                        name="summary-template"
                        checked={on}
                        onChange={() => setSelectedTemplateId(t.id)}
                        className="radio radio-primary radio-sm mt-0.5"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">
                          {t.name}{" "}
                          <span className="text-xs font-normal text-base-content/50">{t.isDefault ? "Default" : t.isBuiltin ? "Built-in" : "Custom"}</span>
                        </span>
                        {t.description && <span className="block text-xs text-base-content/60">{t.description}</span>}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </fieldset>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <FieldLabel>Model</FieldLabel>
              <Combobox
                value={`${selectedProvider}::${selectedModel}`}
                onChange={handleModelChange}
                placeholder="Select model…"
                ariaLabel="Model"
                searchPlaceholder="Search models…"
                emptyText="No models match your search."
                options={modelChoices}
              />
            </div>
            <div>
              <FieldLabel>Write it in</FieldLabel>
              <Combobox
                value={language}
                onChange={setLanguage}
                placeholder="Select language…"
                ariaLabel="Summary language"
                searchPlaceholder="Search languages…"
                options={languageOptions("Default from settings", SUMMARY_AUTO_LABEL)}
              />
            </div>
          </div>

          {selectedModelObj?.reasoning && (
            <div>
              <FieldLabel>Thinking</FieldLabel>
              {thinkingLevels.length <= 5 ? (
                <Segmented
                  ariaLabel="Thinking"
                  value={thinkingLevel}
                  onChange={setThinkingLevel}
                  options={thinkingLevels.map((lvl) => ({ value: lvl, label: THINKING_LABELS[lvl] ?? lvl }))}
                />
              ) : (
                <Combobox
                  value={thinkingLevel}
                  onChange={setThinkingLevel}
                  ariaLabel="Thinking"
                  options={thinkingLevels.map((lvl) => ({ value: lvl, label: THINKING_LABELS[lvl] ?? lvl }))}
                />
              )}
            </div>
          )}

          <label className="flex cursor-pointer items-center gap-2.5 text-sm">
            <input type="checkbox" checked={setPrimary} onChange={(e) => setSetPrimary(e.target.checked)} className="checkbox checkbox-primary checkbox-sm" />
            Make it the primary summary
          </label>

          <ModalFooter>
            <button type="button" onClick={onClose} disabled={starting} className="btn min-h-11 lg:min-h-0">
              Cancel
            </button>
            <button type="submit" disabled={starting} className="btn btn-primary min-h-11 lg:min-h-0">
              {starting ? "Starting…" : "Generate"}
            </button>
          </ModalFooter>
        </form>
      )}
    </Modal>
  );
}

export interface RapidEnrollCompletion {
  label: string;
  targetName: string;
  updatedSegmentsCount: number;
  enrolledSamplesCount: number;
  sampleCount: number;
  notes: string[];
}

export function RapidEnrollModal({
  meetingId,
  knownSpeakers,
  playingSegmentIndex,
  onPlaySample,
  onClose,
  onAssigned
}: {
  meetingId: string;
  knownSpeakers: SpeakerWithStats[];
  playingSegmentIndex: number | null;
  onPlaySample: (sample: { startMs: number; endMs: number; segmentIndex: number }) => void;
  onClose: () => void;
  onAssigned: () => void;
}): ReactElement {
  const [groups, setGroups] = useState<RapidEnrollCandidateGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedSamples, setSelectedSamples] = useState<Record<string, number[]>>({});
  const [targets, setTargets] = useState<Record<string, { speakerId: string; customName: string }>>({});
  // Labels with an in-flight assign request. Assigns run in the background
  // so the user can keep enrolling other voices while embeddings train.
  const [pendingLabels, setPendingLabels] = useState<Record<string, string>>({});
  const [failedLabels, setFailedLabels] = useState<Record<string, string>>({});
  const [completions, setCompletions] = useState<RapidEnrollCompletion[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/meetings/${meetingId}/speakers/rapid-enroll-candidates?limit=5`);
        const data = (await res.json().catch(() => ({}))) as { groups?: RapidEnrollCandidateGroup[]; error?: string };
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        if (cancelled) return;
        const loaded = data.groups ?? [];
        setGroups(loaded);
        // Pre-check the top 3 enrollment-eligible samples per group.
        setSelectedSamples((prev) => {
          const next = { ...prev };
          for (const g of loaded) {
            if (!(g.label in next)) next[g.label] = defaultSampleSelection(g);
          }
          return next;
        });
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load enrollment candidates");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [meetingId]);

  const toggleSample = (label: string, segmentIndex: number) => {
    setSelectedSamples((prev) => {
      const current = prev[label] ?? [];
      return {
        ...prev,
        [label]: current.includes(segmentIndex)
          ? current.filter((i) => i !== segmentIndex)
          : [...current, segmentIndex]
      };
    });
  };

  const handleAssign = (group: RapidEnrollCandidateGroup) => {
    const target = targets[group.label] ?? { speakerId: "", customName: "" };
    let toSpeakerId: string | undefined;
    let toSpeakerName: string | undefined;
    if (target.speakerId && target.speakerId !== "new") {
      toSpeakerId = target.speakerId;
      toSpeakerName = knownSpeakers.find((s) => s.id === target.speakerId)?.name;
    } else {
      toSpeakerName = target.customName.trim();
    }
    if (!toSpeakerName && !toSpeakerId) {
      notify("warning", "Pick an existing person or enter a name first");
      return;
    }
    // Send samples in ranked order so the best clips enroll first.
    const segmentIndices = (group.samples ?? [])
      .map((s) => s.segmentIndex)
      .filter((idx) => (selectedSamples[group.label] ?? []).includes(idx));
    const displayName = toSpeakerName ?? knownSpeakers.find((s) => s.id === toSpeakerId)?.name ?? "speaker";

    // Optimistic update: remove the group immediately so the UI stays
    // interactive while enrollment trains in the background.
    setGroups((prev) => (prev ?? []).filter((g) => g.label !== group.label));
    setPendingLabels((prev) => ({ ...prev, [group.label]: displayName }));
    setFailedLabels((prev) => {
      if (!(group.label in prev)) return prev;
      const next = { ...prev };
      delete next[group.label];
      return next;
    });

    void assignRapidEnroll(meetingId, { fromLabel: group.label, toSpeakerId, toSpeakerName, segmentIndices })
      .then((data) => {
        setCompletions((prev) => [
          {
            label: group.label,
            targetName: data.speaker?.name ?? displayName,
            updatedSegmentsCount: data.updatedSegmentsCount ?? 0,
            enrolledSamplesCount: data.enrolledSamplesCount ?? 0,
            sampleCount: segmentIndices.length,
            notes: (data.sampleResults ?? [])
              .filter((r) => !r.voiceprintEnrolled && r.statusReason)
              .map((r) => r.statusReason as string)
          },
          ...prev
        ]);
        onAssigned();
      })
      .catch((err) => {
        // Restore the group so the user can retry.
        setGroups((prev) => (prev ? [...prev, group] : [group]));
        setFailedLabels((prev) => ({
          ...prev,
          [group.label]: err instanceof Error ? err.message : String(err)
        }));
      })
      .finally(() => {
        setPendingLabels((prev) => {
          if (!(group.label in prev)) return prev;
          const next = { ...prev };
          delete next[group.label];
          return next;
        });
      });
  };

  return (
    <Modal onClose={onClose} title="Identify voices" ariaLabel="Identify voices in this meeting" maxWidth="max-w-3xl">
      <p className="text-sm text-base-content/60">
        Voices in this meeting that are unknown or matched but not confirmed yet, with their clearest clips. Listen, keep
        the good clips checked, then say who it is — every turn for that voice is renamed and the checked clips teach Olive
        their voice.
      </p>

      <div className="mt-4 space-y-3">
        {error && <div className="rounded-lg bg-error/10 p-3 text-sm text-error">{error}</div>}
        {groups === null && !error && (
          <p className="flex items-center gap-2 text-sm text-base-content/60">
            <Spinner /> Finding voices to identify…
          </p>
        )}
        {groups !== null && groups.length === 0 && completions.length === 0 && Object.keys(pendingLabels).length === 0 && (
          <p className="flex items-center gap-2 rounded-lg bg-hover p-3 text-sm">
            <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            Nothing left to identify — every voice in this meeting is named and confirmed.
          </p>
        )}

        {Object.entries(pendingLabels).map(([label, targetName]) => (
          <div key={`pending-${label}`} className="flex items-center gap-2 rounded-lg bg-warning/10 p-3 text-sm text-warning">
            <Clock className="h-4 w-4 shrink-0" aria-hidden="true" />
            “{label}” is {targetName} — renaming now, learning the voice in the background…
          </div>
        ))}

        {Object.entries(failedLabels).map(([label, message]) => (
          <div key={`failed-${label}`} className="rounded-lg bg-error/10 p-3 text-sm text-error">
            <p className="font-medium">Couldn't assign “{label}”: {message}</p>
            <p className="mt-0.5 text-xs">The voice is back in the list so you can try again.</p>
          </div>
        ))}

        {completions.map((c) => (
          <div key={`${c.label}-${c.targetName}`} className="rounded-lg bg-primary/10 p-3 text-sm text-primary">
            <p className="flex items-center gap-2 font-medium">
              <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
              “{c.label}” is {c.targetName} — renamed {c.updatedSegmentsCount} turn{c.updatedSegmentsCount === 1 ? "" : "s"}, learned from{" "}
              {c.enrolledSamplesCount}/{c.sampleCount} clip{c.sampleCount === 1 ? "" : "s"}
            </p>
            {c.notes.map((note, i) => (
              <p key={i} className="mt-1 text-xs text-primary/80">{note}</p>
            ))}
          </div>
        ))}

        {(groups ?? []).map((group) => {
          const target = targets[group.label] ?? { speakerId: "", customName: "" };
          const targetName =
            target.speakerId && target.speakerId !== "new"
              ? knownSpeakers.find((s) => s.id === target.speakerId)?.name
              : target.customName.trim();
          return (
            <section key={group.label} className="space-y-3 rounded-box border border-base-300 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-semibold">{group.label}</h3>
                <span className={`tag ${group.status === "unmatched" ? "" : "tag-yellow"}`}>
                  {group.status === "unmatched" ? "Unknown voice" : "Likely match"}
                </span>
                <span className="text-xs text-base-content/50">
                  {group.segmentCount} turn{group.segmentCount === 1 ? "" : "s"} · {formatDuration(group.totalDurationMs ?? 0)} of speech
                </span>
              </div>
              <p className="text-xs text-base-content/50">{group.reason}</p>

              <div className="space-y-1">
                {(group.samples ?? []).map((sample) => (
                  <ClipRow
                    key={sample.segmentIndex}
                    startMs={sample.startMs}
                    durationMs={sample.durationMs}
                    text={sample.text}
                    playing={playingSegmentIndex === sample.segmentIndex}
                    onPlay={() => onPlaySample(sample)}
                    checked={(selectedSamples[group.label] ?? []).includes(sample.segmentIndex)}
                    onToggle={() => toggleSample(group.label, sample.segmentIndex)}
                    note={!sample.enrollEligible ? "under 3s — too short to learn from (rename only)" : undefined}
                  />
                ))}
              </div>

              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <SpeakerCombobox
                    value={target.speakerId}
                    onChange={(next) => setTargets((prev) => ({ ...prev, [group.label]: { ...target, speakerId: next } }))}
                    knownSpeakers={knownSpeakers}
                    emptyLabel="Choose or create a person…"
                    ariaLabel={`Who is ${group.label}?`}
                  />
                </div>
                {(target.speakerId === "new" || !target.speakerId) && (
                  <input
                    type="text"
                    placeholder="New person's name"
                    value={target.customName}
                    onChange={(e) => setTargets((prev) => ({ ...prev, [group.label]: { ...target, customName: e.target.value } }))}
                    className="input min-h-11 sm:w-48 lg:min-h-0"
                    aria-label="New person name"
                  />
                )}
                <button type="button" onClick={() => handleAssign(group)} className="btn btn-primary min-h-11 shrink-0 lg:min-h-0">
                  {targetName ? `This is ${targetName}` : "Assign"}
                </button>
              </div>
            </section>
          );
        })}
      </div>

      <ModalFooter>
        <button type="button" onClick={onClose} className="btn min-h-11 lg:min-h-0">
          Done
        </button>
      </ModalFooter>
    </Modal>
  );
}

/** Top 3 enrollment-eligible clips of a rapid-enroll group (falls back to the first clip). */
export function defaultSampleSelection(group: RapidEnrollCandidateGroup): number[] {
  const eligible = (group.samples ?? []).filter((s) => s.enrollEligible);
  const chosen = (eligible.length > 0 ? eligible : (group.samples ?? []).slice(0, 1)).slice(0, 3);
  return chosen.map((s) => s.segmentIndex);
}

export async function assignRapidEnroll(
  meetingId: string,
  body: { fromLabel: string; toSpeakerId?: string; toSpeakerName?: string; segmentIndices: number[] }
): Promise<RapidEnrollAssignResponse> {
  const res = await fetch(`/api/meetings/${meetingId}/speakers/rapid-enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = (await res.json().catch(() => ({}))) as RapidEnrollAssignResponse & { error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/** One playable clip: play button, quote, length; optional checkbox. */
export function ClipRow({
  startMs,
  durationMs,
  text,
  playing,
  onPlay,
  checked,
  onToggle,
  note
}: {
  startMs: number;
  durationMs: number;
  text: string;
  playing: boolean;
  onPlay: () => void;
  checked?: boolean;
  onToggle?: () => void;
  note?: string;
}): ReactElement {
  return (
    <div className="flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 hover:bg-hover">
      {onToggle && (
        <input
          type="checkbox"
          checked={!!checked}
          onChange={onToggle}
          className="checkbox checkbox-sm shrink-0"
          aria-label={`Learn from clip at ${formatTimeOffset(startMs)}`}
        />
      )}
      <button
        type="button"
        onClick={onPlay}
        aria-label={playing ? "Pause clip" : `Play clip at ${formatTimeOffset(startMs)}`}
        className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition lg:h-7 lg:w-7 ${
          playing ? "border-transparent bg-base-content text-base-100" : "border-base-300 bg-base-100 hover:bg-hover"
        }`}
      >
        {playing ? <Pause className="h-3 w-3" aria-hidden="true" /> : <Play className="h-3 w-3" aria-hidden="true" />}
      </button>
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-[13px] leading-snug">“{text}”</span>
        {note && <span className="block text-xs text-warning">{note}</span>}
      </span>
      <span className="shrink-0 font-mono text-xs text-base-content/50">
        {formatTimeOffset(startMs)} · {(durationMs / 1000).toFixed(0)}s
      </span>
    </div>
  );
}

export function ReassignSpeakerModal({
  meetingId,
  fromLabel,
  segmentIndex,
  knownSpeakers,
  turnCount,
  sample,
  samplePlaying = false,
  onPlaySample,
  onClose,
  onSuccess,
  onSettled
}: {
  meetingId: string;
  fromLabel: string;
  segmentIndex?: number;
  knownSpeakers: SpeakerWithStats[];
  /** How many turns carry `fromLabel` (for the "All N turns" choice). */
  turnCount?: number;
  /** A clip of this voice to listen to before deciding. */
  sample?: { startMs: number; endMs: number; text: string };
  samplePlaying?: boolean;
  onPlaySample?: () => void;
  onClose: () => void;
  onSuccess: (optimistic?: { targetName: string; scope: "single" | "all"; segmentIndex?: number }) => void;
  onSettled?: () => void;
}): ReactElement {
  const [selectedSpeakerId, setSelectedSpeakerId] = useState<string>("");
  const [customName, setCustomName] = useState<string>("");
  const [scope, setScope] = useState<"single" | "all">(segmentIndex !== undefined && !isGenericSpeakerLabel(fromLabel) ? "single" : "all");
  const [adoptVoiceprint, setAdoptVoiceprint] = useState(true);
  const [saveToPeople, setSaveToPeople] = useState(true);

  const localOnly = !saveToPeople;
  const needsName = localOnly || selectedSpeakerId === "new" || !selectedSpeakerId;
  const targetName = needsName ? customName.trim() : knownSpeakers.find((s) => s.id === selectedSpeakerId)?.name ?? "";

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    let resolvedTargetName = "";
    let targetId: string | undefined = undefined;

    if (needsName) {
      if (!customName.trim()) {
        notify("warning", localOnly ? "Enter the name to show in this meeting" : "Enter a name for the new person");
        return;
      }
      resolvedTargetName = customName.trim();
    } else {
      targetId = selectedSpeakerId;
      const matched = knownSpeakers.find((s) => s.id === selectedSpeakerId);
      resolvedTargetName = matched ? matched.name : selectedSpeakerId;
    }

    const payload: any = {
      fromLabel,
      adoptVoiceprint: localOnly ? false : adoptVoiceprint,
      localOnly,
      segmentIndex,
      scope,
      toSpeakerName: resolvedTargetName,
      toSpeakerId: targetId
    };

    // 1. Immediately dismiss modal and optimistically update caller
    onSuccess({
      targetName: resolvedTargetName,
      scope,
      segmentIndex
    });

    // 2. Fire request asynchronously in background, then sync canonical state once it completes
    void fetch(`/api/meetings/${meetingId}/speakers/reassign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    })
      .then(async (res) => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          console.error("Async speaker reassignment error:", data.error || `HTTP ${res.status}`);
          notify("error", `Couldn't assign speaker: ${data.error || `HTTP ${res.status}`}`);
        }
      })
      .catch((err) => {
        console.error("Async speaker reassignment network error:", err);
      })
      .finally(() => {
        onSettled?.();
      });
  };

  const generic = isGenericSpeakerLabel(fromLabel);

  return (
    <Modal onClose={onClose} title={generic ? `Who is ${fromLabel}?` : `Change speaker: ${fromLabel}`} ariaLabel="Assign speaker" maxWidth="max-w-md">
      <form onSubmit={handleSubmit} className="space-y-4">
        {sample && onPlaySample && (
          <div className="flex items-center gap-2.5 rounded-lg bg-hover px-3 py-2.5">
            <button
              type="button"
              onClick={onPlaySample}
              aria-label={samplePlaying ? "Pause clip" : "Play clip"}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-base-content text-base-100 lg:h-8 lg:w-8"
            >
              {samplePlaying ? <Pause className="h-3.5 w-3.5" aria-hidden="true" /> : <Play className="h-3.5 w-3.5" aria-hidden="true" />}
            </button>
            <span className="line-clamp-2 min-w-0 flex-1 text-[13px]">“{sample.text}”</span>
            <span className="shrink-0 font-mono text-xs text-base-content/50">{formatTimeOffset(sample.startMs)}</span>
          </div>
        )}

        <Segmented
          ariaLabel="Where to save the name"
          value={saveToPeople ? "people" : "local"}
          onChange={(v) => setSaveToPeople(v === "people")}
          options={[
            { value: "people", label: "Save to People" },
            { value: "local", label: "This meeting only" }
          ]}
        />

        {saveToPeople ? (
          <div className="space-y-2">
            <FieldLabel>Person</FieldLabel>
            <SpeakerCombobox
              value={selectedSpeakerId}
              onChange={setSelectedSpeakerId}
              knownSpeakers={knownSpeakers}
              emptyLabel="Choose or create a person…"
              createLabel="Create person"
              ariaLabel="Person"
            />
            {(selectedSpeakerId === "new" || !selectedSpeakerId) && (
              <input
                type="text"
                placeholder="New person's name"
                aria-label="New person's name"
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                className="input w-full"
              />
            )}
          </div>
        ) : (
          <div>
            <FieldLabel htmlFor="reassign-display-name">Name in this meeting</FieldLabel>
            <input
              id="reassign-display-name"
              type="text"
              placeholder="e.g. Fred"
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              className="input w-full"
            />
            <p className="mt-1.5 text-xs text-base-content/50">Only relabels this transcript — nothing is added to People and no voice is learned.</p>
          </div>
        )}

        <div className="space-y-2 text-sm">
          {segmentIndex !== undefined && (
            <>
              <label className="flex cursor-pointer items-center gap-2.5">
                <input type="radio" name="reassign-scope" checked={scope === "all"} onChange={() => setScope("all")} className="radio radio-primary radio-sm" />
                <span>{turnCount ? `All ${turnCount} turns of ${fromLabel}` : `All turns of ${fromLabel}`}</span>
              </label>
              <label className="flex cursor-pointer items-center gap-2.5">
                <input type="radio" name="reassign-scope" checked={scope === "single"} onChange={() => setScope("single")} className="radio radio-primary radio-sm" />
                <span>Only this turn</span>
              </label>
            </>
          )}
          {saveToPeople && (
            <label className="flex cursor-pointer items-center gap-2.5">
              <input type="checkbox" checked={adoptVoiceprint} onChange={(e) => setAdoptVoiceprint(e.target.checked)} className="checkbox checkbox-primary checkbox-sm" />
              <span>Learn this voice so Olive recognizes them next time</span>
            </label>
          )}
        </div>

        <ModalFooter>
          <button type="button" onClick={onClose} className="btn min-h-11 lg:min-h-0">
            Cancel
          </button>
          <button type="submit" className="btn btn-primary min-h-11 lg:min-h-0">
            {targetName ? `Assign to ${targetName}` : "Assign"}
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

export function SplitSegmentModal({
  meetingId,
  segment,
  knownSpeakers,
  onClose,
  onSuccess
}: {
  meetingId: string;
  segment: {
    segmentIndex: number;
    speaker: string;
    text: string;
    startMs: number;
    endMs: number;
  };
  knownSpeakers: SpeakerWithStats[];
  onClose: () => void;
  onSuccess: () => void;
}): ReactElement {
  const words = useMemo(() => segment.text.split(/\s+/).filter(Boolean), [segment.text]);
  const [splitWordIndex, setSplitWordIndex] = useState<number>(Math.max(1, Math.floor(words.length / 2)));
  const [selectedSpeakerId, setSelectedSpeakerId] = useState<string>("");
  const [customName, setCustomName] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);

  const durationMs = segment.endMs - segment.startMs;
  const ratio = splitWordIndex / Math.max(1, words.length);
  const splitTimestamp = Math.round(segment.startMs + ratio * durationMs);

  const part1Text = words.slice(0, splitWordIndex).join(" ");
  const part2Text = words.slice(splitWordIndex).join(" ");

  const part2SpeakerName =
    selectedSpeakerId === "new"
      ? customName || "New person"
      : selectedSpeakerId
      ? knownSpeakers.find((s) => s.id === selectedSpeakerId)?.name || segment.speaker
      : segment.speaker;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);

    try {
      const payload: any = {
        segmentIndex: segment.segmentIndex,
        wordIndex: splitWordIndex
      };

      if (selectedSpeakerId === "new") {
        if (!customName.trim()) {
          notify("warning", "Enter a name for the new person");
          setSubmitting(false);
          return;
        }
        payload.newSpeakerName = customName.trim();
      } else if (selectedSpeakerId) {
        payload.newSpeakerId = selectedSpeakerId;
        const matched = knownSpeakers.find((s) => s.id === selectedSpeakerId);
        if (matched) {
          payload.newSpeakerName = matched.name;
        }
      }

      const res = await fetch(`/api/meetings/${meetingId}/speakers/split-segment`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      onSuccess();
    } catch (err) {
      notify("error", `Failed to split turn: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal onClose={onClose} title={`Split turn: ${segment.speaker}`} ariaLabel="Split turn" maxWidth="max-w-2xl">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <FieldLabel>Click the word where the second part starts</FieldLabel>
          <div className="flex max-h-56 flex-wrap items-center gap-1 overflow-y-auto rounded-lg border border-base-300 p-3 leading-loose">
            {words.map((word, idx) => {
              const isPart1 = idx < splitWordIndex;
              const isSplitTarget = idx === splitWordIndex;
              return (
                <Fragment key={idx}>
                  {isSplitTarget && (
                    <span className="inline-flex items-center gap-1 rounded bg-warning/15 px-1.5 text-xs font-medium text-warning">
                      <Scissors className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> Split
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => setSplitWordIndex(idx === 0 ? 1 : idx)}
                    className={`rounded px-1 text-sm transition hover:bg-hover ${isPart1 ? "text-base-content" : "text-base-content/55"}`}
                    title={`Split before "${word}"`}
                  >
                    {word}
                  </button>
                </Fragment>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="space-y-1 rounded-lg bg-hover p-3">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-medium">Part 1 · {segment.speaker}</span>
              <span className="font-mono text-base-content/50">
                {formatTimeOffset(segment.startMs)} → {formatTimeOffset(splitTimestamp)}
              </span>
            </div>
            <p className="line-clamp-4 text-xs text-base-content/70">“{part1Text || "(empty)"}”</p>
          </div>
          <div className="space-y-1 rounded-lg bg-hover p-3">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-medium">Part 2 · {part2SpeakerName}</span>
              <span className="font-mono text-base-content/50">
                {formatTimeOffset(splitTimestamp)} → {formatTimeOffset(segment.endMs)}
              </span>
            </div>
            <p className="line-clamp-4 text-xs text-base-content/70">“{part2Text || "(empty)"}”</p>
          </div>
        </div>

        <div className="space-y-2">
          <FieldLabel>Speaker for part 2</FieldLabel>
          <SpeakerCombobox
            value={selectedSpeakerId}
            onChange={setSelectedSpeakerId}
            knownSpeakers={knownSpeakers}
            emptyLabel={`Keep as ${segment.speaker}`}
            createLabel="Create person"
            ariaLabel="Speaker for part 2"
          />
          {selectedSpeakerId === "new" && (
            <input
              type="text"
              placeholder="New person's name"
              aria-label="New person's name"
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              className="input w-full"
            />
          )}
        </div>

        <ModalFooter>
          <button type="button" onClick={onClose} className="btn min-h-11 lg:min-h-0">
            Cancel
          </button>
          <button type="submit" disabled={submitting || !part1Text || !part2Text} className="btn btn-primary min-h-11 lg:min-h-0">
            {submitting ? "Splitting…" : "Split turn"}
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

export const SPLIT_EDGE_MS = 5000;

export function SplitMeetingModal({
  totalMs,
  initialMs,
  getPlayheadMs,
  busy,
  onClose,
  onConfirm
}: {
  totalMs: number;
  initialMs: number | null;
  getPlayheadMs: () => number | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: (splitMs: number) => void;
}): ReactElement {
  const clamp = (ms: number) => Math.min(Math.max(ms, SPLIT_EDGE_MS), totalMs - SPLIT_EDGE_MS);
  const [splitMs, setSplitMs] = useState<number>(() => clamp(initialMs ?? Math.round(totalMs / 2)));
  const valid = splitMs >= SPLIT_EDGE_MS && splitMs <= totalMs - SPLIT_EDGE_MS;

  return (
    <Modal onClose={onClose} title="Split meeting in two" ariaLabel="Split meeting" maxWidth="max-w-md">
      <div className="space-y-4 text-sm">
        <p className="text-base-content/70">
          The audio and transcript are cut at the same point — nothing is re-transcribed. Part 2 becomes a new meeting.
        </p>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="split-meeting-at" className="font-medium">
              Split at <span className="font-mono">{formatTimeOffset(splitMs)}</span>
            </label>
            <button
              type="button"
              onClick={() => {
                const ms = getPlayheadMs();
                if (ms !== null) setSplitMs(clamp(ms));
              }}
              className="btn btn-ghost btn-sm min-h-11 lg:min-h-0"
            >
              Use playhead
            </button>
          </div>
          <input
            id="split-meeting-at"
            type="range"
            min={Math.floor(SPLIT_EDGE_MS / 1000)}
            max={Math.floor((totalMs - SPLIT_EDGE_MS) / 1000)}
            step={1}
            value={Math.floor(splitMs / 1000)}
            onChange={(e) => setSplitMs(clamp(Number(e.target.value) * 1000))}
            className="range range-xs range-primary w-full"
          />
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-lg bg-hover p-3">
            <p className="font-medium">Part 1 (this meeting)</p>
            <p className="mt-1 font-mono text-base-content/60">00:00 → {formatTimeOffset(splitMs)}</p>
          </div>
          <div className="rounded-lg bg-hover p-3">
            <p className="font-medium">Part 2 (new meeting)</p>
            <p className="mt-1 font-mono text-base-content/60">
              {formatTimeOffset(splitMs)} → {formatTimeOffset(totalMs)}
            </p>
          </div>
        </div>
        <p className="text-xs text-warning">
          Summaries on both parts are deleted because they described the whole recording. Delete the half you don't need afterwards if you only want one.
        </p>
      </div>
      <ModalFooter>
        <button type="button" onClick={onClose} disabled={busy} className="btn min-h-11 lg:min-h-0">
          Cancel
        </button>
        <button type="button" onClick={() => onConfirm(splitMs)} disabled={busy || !valid} className="btn btn-primary min-h-11 lg:min-h-0">
          {busy ? "Splitting…" : "Split meeting"}
        </button>
      </ModalFooter>
    </Modal>
  );
}

export function MergeMeetingModal({
  meetingId,
  meetingTitle,
  meetingStartTime,
  onClose,
  onMerged
}: {
  meetingId: string;
  meetingTitle: string;
  meetingStartTime: number;
  onClose: () => void;
  onMerged: (mergedMeetingId: string | null) => void;
}): ReactElement {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MeetingsResponse["meetings"]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<MeetingsResponse["meetings"][number] | null>(null);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ limit: "8", offset: "0" });
        if (query.trim()) params.set("search", query.trim());
        const res = await fetch(`/api/meetings?${params.toString()}`, { signal: controller.signal });
        if (res.ok) {
          const data = (await res.json()) as MeetingsResponse;
          setResults(data.meetings.filter((m) => m.id !== meetingId));
        }
      } catch {
        // aborted or offline: keep the previous results
      } finally {
        setLoading(false);
      }
    }, 150);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, meetingId]);

  const ordered = selected
    ? [
        { id: meetingId, title: meetingTitle, startTime: meetingStartTime },
        { id: selected.id, title: selected.title, startTime: selected.startTime }
      ].sort((a, b) => a.startTime - b.startTime)
    : [];

  const handleMerge = async () => {
    if (!selected || merging) return;
    setMerging(true);
    setError(null);
    try {
      const res = await fetch("/api/meetings/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meetingIds: ordered.map((m) => m.id) })
      });
      const data = (await res.json().catch(() => ({}))) as { meeting?: { id?: string }; error?: string };
      if (!res.ok) throw new Error(data.error || `Failed to merge meetings (HTTP ${res.status})`);
      onMerged(data.meeting?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to merge meetings");
      setMerging(false);
    }
  };

  return (
    <Modal onClose={onClose} title="Merge with another meeting" ariaLabel="Merge with another meeting" maxWidth="max-w-lg">
      <div className="space-y-4 text-sm">
        {error && <div className="rounded-lg bg-error/10 p-3 text-error">{error}</div>}
        <label className="flex h-10 items-center gap-2 rounded-lg bg-hover px-3 text-base-content/60">
          <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search meetings"
            aria-label="Search meetings"
            className="w-full bg-transparent text-base-content outline-none"
            autoFocus
          />
          {loading && <Spinner className="h-3.5 w-3.5" />}
        </label>
        <div role="listbox" aria-label="Meetings" className="max-h-64 space-y-0.5 overflow-y-auto">
          {results.length === 0 && !loading && <p className="px-2 py-3 text-base-content/50">No meetings found.</p>}
          {results.map((m) => (
            <button
              key={m.id}
              type="button"
              role="option"
              aria-selected={selected?.id === m.id}
              onClick={() => setSelected(m)}
              className={`flex min-h-11 w-full items-center gap-3 rounded-md px-2.5 text-left transition ${selected?.id === m.id ? "bg-active" : "hover:bg-hover"}`}
            >
              <AudioLines className="h-4 w-4 shrink-0 text-base-content/50" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{m.title}</span>
              <span className="shrink-0 text-xs text-base-content/50">{formatDate(m.startTime)}</span>
            </button>
          ))}
        </div>
        {selected && (
          <p className="rounded-lg bg-warning/10 p-3 text-xs text-warning">
            Joins “{ordered[0].title}” and “{ordered[1].title}” in chronological order into “{ordered[0].title}”. Audio and transcripts are
            joined without re-transcription, the later meeting is deleted, and summaries are dropped.
          </p>
        )}
      </div>
      <ModalFooter>
        <button type="button" onClick={onClose} disabled={merging} className="btn min-h-11 lg:min-h-0">
          Cancel
        </button>
        <button type="button" onClick={() => void handleMerge()} disabled={!selected || merging} className="btn btn-primary min-h-11 lg:min-h-0">
          {merging ? "Merging…" : "Merge meetings"}
        </button>
      </ModalFooter>
    </Modal>
  );
}

export interface TranscribeOptions {
  engine: string;
  language: string;
  modalAsrModel: ModalAsrModel;
  clusteringThreshold: number;
  similarityThreshold: number;
}

export function TranscribeModal({
  hasTranscript,
  turnCount,
  summaryCount,
  options,
  onOptionsChange,
  onClose,
  onConfirm
}: {
  hasTranscript: boolean;
  turnCount: number;
  summaryCount: number;
  options: TranscribeOptions;
  onOptionsChange: (next: TranscribeOptions) => void;
  onClose: () => void;
  onConfirm: () => void;
}): ReactElement {
  const set = (patch: Partial<TranscribeOptions>) => onOptionsChange({ ...options, ...patch });
  const isLocal = options.engine.startsWith("local");

  return (
    <Modal onClose={onClose} title={hasTranscript ? "Re-transcribe this meeting?" : "Transcribe this meeting"} ariaLabel="Transcribe meeting" maxWidth="max-w-md">
      <div className="space-y-4 text-sm">
        {hasTranscript && (
          <div className="flex gap-2.5 rounded-lg bg-warning/10 p-3 text-warning">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <div className="space-y-1">
              <p>
                The current transcript{turnCount > 0 ? ` (${turnCount} turns)` : ""} is replaced, including the speaker names you assigned or confirmed in
                this meeting.
              </p>
              <p className="text-warning/80">
                {summaryCount > 0
                  ? `Your ${summaryCount} summar${summaryCount === 1 ? "y is" : "ies are"} kept but won't update on their own. `
                  : ""}
                People and their learned voices are not affected.
              </p>
            </div>
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <FieldLabel>Engine</FieldLabel>
            <Combobox
              value={options.engine}
              onChange={(v) => set({ engine: v })}
              placeholder="Select engine…"
              ariaLabel="Transcription engine"
              searchPlaceholder="Search engines…"
              options={ENGINE_OPTIONS}
            />
          </div>
          <div>
            <FieldLabel>Language</FieldLabel>
            <Combobox
              value={options.language}
              onChange={(v) => set({ language: v })}
              placeholder="Select language…"
              ariaLabel="Transcription language"
              searchPlaceholder="Search languages…"
              options={languageOptions("Default language", TRANSCRIPTION_AUTO_LABEL)}
            />
          </div>
        </div>
        {options.engine === "modal" && (
          <div>
            <FieldLabel>Speech-to-text model</FieldLabel>
            <Combobox
              value={options.modalAsrModel}
              onChange={(v) => set({ modalAsrModel: v as ModalAsrModel })}
              placeholder="Select model…"
              ariaLabel="Modal speech-to-text model"
              searchPlaceholder="Search models…"
              options={MODAL_ASR_MODEL_OPTIONS}
            />
          </div>
        )}
        {isLocal && (
          <details className="rounded-lg border border-base-300 px-3 py-2">
            <summary className="cursor-pointer text-[13px] text-base-content/60">Advanced: voice matching</summary>
            <div className="pt-3">
              <VoiceMatchingControls
                idPrefix="transcribe"
                similarity={options.similarityThreshold}
                onSimilarityChange={(v) => set({ similarityThreshold: v })}
                clustering={options.clusteringThreshold}
                onClusteringChange={(v) => set({ clusteringThreshold: v })}
              />
            </div>
          </details>
        )}
        <p className="text-xs text-base-content/50">Runs in the background — you can keep working. Defaults come from Settings.</p>
      </div>
      <ModalFooter>
        <button type="button" onClick={onClose} className="btn min-h-11 lg:min-h-0">
          Cancel
        </button>
        <button type="button" onClick={onConfirm} className="btn btn-primary min-h-11 lg:min-h-0">
          {hasTranscript ? "Re-transcribe" : "Transcribe"}
        </button>
      </ModalFooter>
    </Modal>
  );
}

export function UploadAudioModal({
  onClose,
  onUploaded
}: {
  onClose: () => void;
  onUploaded: (meetingId: string) => void;
}): ReactElement {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [autoTranscribe, setAutoTranscribe] = useState(true);
  const [selectedEngine, setSelectedEngine] = useState<string>("local:cohere");
  const [transcriptionLanguage, setTranscriptionLanguage] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void fetch("/api/config")
      .then((res) => (res.ok ? res.json() : null))
      .then((config) => {
        if (config?.transcriptionProvider === "speechmatics" || config?.transcriptionProvider === "assemblyai" || config?.transcriptionProvider === "muse" || config?.transcriptionProvider === "modal") {
          setSelectedEngine(config.transcriptionProvider);
        } else {
          setSelectedEngine("local:cohere");
        }
      })
      .catch(() => {});
  }, []);

  const pickFile = (selected: File) => {
    setFile(selected);
    if (!title.trim()) {
      setTitle(selected.name.replace(/\.[^/.]+$/, "").replace(/[_-]/g, " "));
    }
  };

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) {
      notify("warning", "Choose an audio file to upload");
      return;
    }

    setUploading(true);
    setError(null);

    const isLocal = selectedEngine.startsWith("local");
    const formData = new FormData();
    formData.append("file", file);
    if (title.trim()) {
      formData.append("title", title.trim());
    }
    formData.append("autoTranscribe", String(autoTranscribe));
    formData.append("provider", isLocal ? "local" : selectedEngine);
    if (isLocal) {
      formData.append("modelId", "onnx-community/cohere-transcribe-03-2026-ONNX");
    }
    if (transcriptionLanguage) {
      formData.append("language", transcriptionLanguage);
    }

    try {
      const res = await fetch("/api/ingest", {
        method: "POST",
        body: formData
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      const data = (await res.json()) as { meetingId: string; deduped: boolean };
      onUploaded(data.meetingId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  return (
    <Modal onClose={onClose} title="Upload audio" ariaLabel="Upload audio" maxWidth="max-w-md">
      <form onSubmit={handleUpload} className="space-y-4 text-sm">
        {error && <div className="rounded-lg bg-error/10 p-3 text-error">{error}</div>}

        <input
          ref={inputRef}
          type="file"
          accept="audio/*,.m4a,.mp3,.wav,.aac,.ogg,.flac,.webm"
          onChange={(e) => {
            if (e.target.files && e.target.files[0]) pickFile(e.target.files[0]);
          }}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
        />

        {file ? (
          <div className="flex items-center gap-3 rounded-lg bg-hover px-3 py-2.5">
            <AudioLines className="h-5 w-5 shrink-0 text-base-content/60" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{file.name}</span>
              <span className="block text-xs text-base-content/50">{(file.size / 1024 / 1024).toFixed(1)} MB</span>
            </span>
            <button type="button" onClick={() => inputRef.current?.click()} className="btn btn-ghost btn-sm min-h-11 lg:min-h-0">
              Replace
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const dropped = e.dataTransfer.files?.[0];
              if (dropped) pickFile(dropped);
            }}
            className={`flex w-full flex-col items-center gap-1.5 rounded-box border-[1.5px] border-dashed px-4 py-6 text-center transition ${
              dragOver ? "border-primary bg-primary/10" : "border-base-300 bg-base-200 hover:bg-hover"
            }`}
          >
            <Upload className="h-6 w-6 text-base-content/50" aria-hidden="true" />
            <span className="font-medium">
              Drop an audio file or <span className="text-primary underline">browse</span>
            </span>
            <span className="text-xs text-base-content/50">m4a, mp3, wav, aac, ogg, flac or webm</span>
          </button>
        )}

        <div>
          <FieldLabel htmlFor="upload-title">Title</FieldLabel>
          <input
            id="upload-title"
            type="text"
            placeholder="e.g. Planning session with the team"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="input w-full"
          />
        </div>

        <label className="flex cursor-pointer items-center justify-between gap-3">
          <span>
            <span className="block font-medium">Transcribe after upload</span>
            <span className="block text-xs text-base-content/50">Runs in the background, you can keep working</span>
          </span>
          <input type="checkbox" role="switch" checked={autoTranscribe} onChange={(e) => setAutoTranscribe(e.target.checked)} className="toggle toggle-primary toggle-sm" />
        </label>

        {autoTranscribe && (
          <div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <FieldLabel>Engine</FieldLabel>
                <Combobox
                  value={selectedEngine}
                  onChange={setSelectedEngine}
                  placeholder="Select engine…"
                  ariaLabel="Transcription engine"
                  searchPlaceholder="Search engines…"
                  options={ENGINE_OPTIONS}
                />
              </div>
              <div>
                <FieldLabel>Language</FieldLabel>
                <Combobox
                  value={transcriptionLanguage}
                  onChange={setTranscriptionLanguage}
                  placeholder="Select language…"
                  ariaLabel="Transcription language"
                  searchPlaceholder="Search languages…"
                  options={languageOptions("Default from settings", TRANSCRIPTION_AUTO_LABEL)}
                />
              </div>
            </div>
            <p className="mt-2 text-xs text-base-content/50">Defaults come from Settings.</p>
          </div>
        )}

        <ModalFooter>
          <button type="button" onClick={onClose} className="btn min-h-11 lg:min-h-0">
            Cancel
          </button>
          <button type="submit" disabled={uploading || !file} className="btn btn-primary min-h-11 lg:min-h-0">
            {uploading ? "Uploading…" : "Upload"}
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
