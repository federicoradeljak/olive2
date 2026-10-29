import React, { Fragment, useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { Check, Pause, Play, Save, Scissors, Zap } from "lucide-react";
import { Combobox } from "../components/Combobox";
import { notify } from "../components/ui";
import { SpeakerCombobox } from "../components/SpeakerCombobox";
import { ENGINE_OPTIONS, SUMMARY_AUTO_LABEL, TRANSCRIPTION_AUTO_LABEL, ThinkingLabel, languageOptions, modelOptions, templateOptions, thinkingLevelOptions } from "../components/OptionComboboxes";
import type { LlmModelCatalogItem, Recording, Speaker, SummaryGenerationStatus, RapidEnrollAssignResponse, RapidEnrollCandidateGroup, Template } from "../api/types.ts";
import { SpeakerWithStats, formatDuration, formatTimeOffset } from "../lib/common";
import { Modal } from "./AppModals";

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

  const handleProviderChange = (pId: string) => {
    setSelectedProvider(pId);
    const pModels = models.filter((m) => m.provider === pId);
    if (pModels.length > 0) {
      setSelectedModel(pModels[0].id);
      const supported = pModels[0].supportedThinkingLevels || ["low", "medium", "high"];
      setThinkingLevel(supported.includes("off") ? "off" : supported[0] || "low");
    }
  };

  const handleModelChange = (mId: string) => {
    setSelectedModel(mId);
    const m = models.find((mod) => mod.provider === selectedProvider && mod.id === mId);
    if (m?.supportedThinkingLevels) {
      if (!m.supportedThinkingLevels.includes(thinkingLevel as any)) {
        setThinkingLevel(m.supportedThinkingLevels[0] || "low");
      }
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

  const providers = Array.from(new Set(models.map((m) => m.provider)));
  const providerModels = models.filter((m) => m.provider === selectedProvider);
  const selectedModelObj = models.find((m) => m.provider === selectedProvider && m.id === selectedModel);

  return (
    <Modal onClose={onClose} title={"Generate AI Summary"} ariaLabel="Generate AI summary" maxWidth="max-w-lg">
      {error && (
        <div className="alert alert-soft alert-error p-3 text-xs text-error">
          {error}
        </div>
      )}

      {loading ? (
        <div className="p-8 text-center text-sm text-base-content/70">Loading templates & models…</div>
      ) : (
        <form onSubmit={handleGenerate} className="space-y-4">
          <div className="space-y-1">
            <label className="text-xs font-medium uppercase tracking-wider text-base-content/70">
              Summary Template
            </label>
            <Combobox
              value={selectedTemplateId}
              onChange={setSelectedTemplateId}
              placeholder="Select template…"
              ariaLabel="Summary template"
              searchPlaceholder="Search templates…"
              emptyText="No templates match your search."
              options={templateOptions(templates)}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="text-xs font-medium uppercase tracking-wider text-base-content/70">
                AI Provider
              </label>
              <Combobox
                value={selectedProvider}
                onChange={handleProviderChange}
                placeholder="Select provider…"
                ariaLabel="AI provider"
                searchPlaceholder="Search providers…"
                options={providers.map((p) => ({
                  value: p,
                  label: p.charAt(0).toUpperCase() + p.slice(1),
                }))}
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium uppercase tracking-wider text-base-content/70">
                Model
              </label>
              <Combobox
                value={selectedModel}
                onChange={handleModelChange}
                placeholder="Select model…"
                ariaLabel="Model"
                searchPlaceholder="Search models…"
                emptyText="No models match your search."
                options={modelOptions(providerModels)}
              />
            </div>
          </div>

          {selectedModelObj && selectedModelObj.reasoning && (
            <div className="space-y-1">
              <label className="text-xs font-medium uppercase tracking-wider text-base-content/70 flex items-center gap-1.5">
                <ThinkingLabel />
              </label>
              <Combobox
                value={thinkingLevel}
                onChange={setThinkingLevel}
                placeholder="Select thinking level…"
                ariaLabel="Thinking reasoning level"
                options={thinkingLevelOptions(selectedModelObj.supportedThinkingLevels || ["low", "medium", "high"])}
              />
            </div>
          )}

          <div className="space-y-1">
            <label className="text-xs font-medium uppercase tracking-wider text-base-content/70">Language</label>
            <Combobox
              value={language}
              onChange={setLanguage}
              placeholder="Select language…"
              ariaLabel="Summary language"
              searchPlaceholder="Search languages…"
              options={languageOptions("Default from settings", SUMMARY_AUTO_LABEL)}
            />
          </div>

          <div className="flex items-center gap-2 pt-1">
            <input
              type="checkbox"
              id="setPrimarySummary"
              checked={setPrimary}
              onChange={(e) => setSetPrimary(e.target.checked)}
              className="checkbox checkbox-primary"
            />
            <label htmlFor="setPrimarySummary" className="text-xs text-base-content cursor-pointer">
              Set as primary summary for this meeting
            </label>
          </div>

          <div className="flex justify-end gap-3 border-t border-base-300 pt-4">
            <button
              type="button"
              onClick={onClose}
              disabled={starting}
              className="btn btn-sm min-h-11"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={starting}
              className="btn btn-primary btn-sm inline-flex items-center gap-2 min-h-11"
            >
              {starting ? "Starting…" : "Generate Summary"}
            </button>
          </div>
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
            if (!(g.label in next)) {
              const eligible = (g.samples ?? []).filter((s) => s.enrollEligible);
              const chosen = (eligible.length > 0 ? eligible : (g.samples ?? []).slice(0, 1)).slice(0, 3);
              next[g.label] = chosen.map((s) => s.segmentIndex);
            }
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

    void fetch(`/api/meetings/${meetingId}/speakers/rapid-enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fromLabel: group.label, toSpeakerId, toSpeakerName, segmentIndices })
    })
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as RapidEnrollAssignResponse & { error?: string };
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
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
    <Modal onClose={onClose} title={<><Zap className="h-4 w-4 shrink-0" aria-hidden="true" /> Rapid enroll</>} ariaLabel="Rapid enroll speakers" maxWidth="max-w-3xl">
      <p className="text-sm text-base-content/70">
        Speakers in this meeting that are unmatched or auto-matched but unverified, with their best voiceprint samples.
        Listen, check the good ones, then say who it is — every turn for that voice gets renamed and the checked samples
        train their voiceprint.
      </p>

      {error && <div className="rounded-xl border border-error bg-error/10 p-4 text-sm text-error">{error}</div>}
      {groups === null && !error && <p className="text-sm text-base-content/70">Finding candidate speakers…</p>}
      {groups !== null && groups.length === 0 && completions.length === 0 && Object.keys(pendingLabels).length === 0 && (
        <p className="rounded-xl border border-base-300 bg-base-100/50 p-4 text-sm text-base-content">
          🎉 Nothing to enroll — every speaker in this meeting is matched and verified.
        </p>
      )}

      {Object.entries(pendingLabels).map(([label, targetName]) => (
        <div key={`pending-${label}`} className="rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm text-warning">
          <p className="font-semibold">
            ⏳ “{label}” is {targetName} — renaming now, enrolling voiceprint in the background…
          </p>
        </div>
      ))}

      {Object.entries(failedLabels).map(([label, message]) => (
        <div key={`failed-${label}`} className="rounded-xl border border-error bg-error/10 p-4 text-sm text-error">
          <p className="font-semibold">Failed to assign “{label}”: {message}</p>
          <p className="mt-1 text-xs">The voice has been restored to the list so you can retry.</p>
        </div>
      ))}

      {completions.map((c) => (
        <div key={`${c.label}-${c.targetName}`} className="rounded-xl border border-primary/40 bg-primary/10 p-4 text-sm text-primary">
          <p className="font-semibold">
            <Check className="h-4 w-4 shrink-0" aria-hidden="true" /> “{c.label}” is {c.targetName} — renamed {c.updatedSegmentsCount} turn{c.updatedSegmentsCount === 1 ? "" : "s"},
            enrolled {c.enrolledSamplesCount}/{c.sampleCount} sample{c.sampleCount === 1 ? "" : "s"}
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
          <section key={group.label} className="space-y-3 rounded-xl border border-base-300 bg-base-100/50 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-semibold text-base-content">“{group.label}”</h3>
              <span
                className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                  group.status === "unmatched"
                    ? "border-warning/40 bg-warning/10 text-warning"
                    : "border-accent/40 bg-accent/10 text-accent"
                }`}
              >
                {group.status === "unmatched" ? "Unmatched" : "Unverified match"}
              </span>
              <span className="text-xs text-base-content/50">
                {group.segmentCount} turn{group.segmentCount === 1 ? "" : "s"} • {formatDuration(group.totalDurationMs ?? 0)} of speech
              </span>
            </div>
            <p className="text-xs text-base-content/50">{group.reason}</p>

            <div className="space-y-2">
              {(group.samples ?? []).map((sample) => (
                <div key={sample.segmentIndex} className="flex items-start gap-2.5 rounded-lg border border-base-300 bg-base-200/70 p-2.5">
                  <input
                    type="checkbox"
                    checked={(selectedSamples[group.label] ?? []).includes(sample.segmentIndex)}
                    onChange={() => toggleSample(group.label, sample.segmentIndex)}
                    className="checkbox mt-1.5 shrink-0"
                    aria-label={`Enroll sample at ${formatTimeOffset(sample.startMs)}`}
                  />
                  <button
                    type="button"
                    onClick={() => onPlaySample(sample)}
                    title={playingSegmentIndex === sample.segmentIndex ? "Pause playback" : "Play this sample"}
                    className={`inline-flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-mono transition ${
                      playingSegmentIndex === sample.segmentIndex
                        ? "border border-primary/40 bg-primary/20 font-bold text-primary"
                        : "border border-base-300/70 bg-base-300/90 text-base-content/70 hover:text-primary"
                    }`}
                  >
                    <span className="text-[10px] inline-flex">{playingSegmentIndex === sample.segmentIndex ? <Pause className="h-3 w-3 shrink-0" aria-hidden="true" /> : <Play className="h-3 w-3 shrink-0" aria-hidden="true" />}</span>
                    <span>{formatTimeOffset(sample.startMs)}</span>
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs leading-relaxed text-base-content line-clamp-2">{sample.text}</p>
                    <p className="mt-0.5 text-[10px] text-base-content/50">
                      {(sample.durationMs / 1000).toFixed(1)}s
                      {!sample.enrollEligible && <span className="text-warning"> • under 3s — too short to enroll (rename only)</span>}
                    </p>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <SpeakerCombobox
                value={target.speakerId}
                onChange={(next) =>
                  setTargets((prev) => ({ ...prev, [group.label]: { ...target, speakerId: next } }))
                }
                knownSpeakers={knownSpeakers}
                emptyLabel="-- Who is this? --"
                ariaLabel={`Who is ${group.label}?`}
              />
              {(target.speakerId === "new" || !target.speakerId) && (
                <input
                  type="text"
                  placeholder="e.g. Asad"
                  value={target.customName}
                  onChange={(e) =>
                    setTargets((prev) => ({ ...prev, [group.label]: { ...target, customName: e.target.value } }))
                  }
                  className="input input-md w-full"
                  aria-label="New person name"
                />
              )}
              <button
                type="button"
                onClick={() => handleAssign(group)}
                className="btn btn-primary inline-flex min-h-[44px] shrink-0 items-center justify-center disabled:cursor-not-allowed disabled:opacity-60"
              >
                {targetName ? `This is ${targetName}` : "Assign & enroll"}
              </button>
            </div>
          </section>
        );
      })}
    </Modal>
  );
}

export function ReassignSpeakerModal({
  meetingId,
  fromLabel,
  segmentIndex,
  knownSpeakers,
  onClose,
  onSuccess,
  onSettled
}: {
  meetingId: string;
  fromLabel: string;
  segmentIndex?: number;
  knownSpeakers: SpeakerWithStats[];
  onClose: () => void;
  onSuccess: (optimistic?: { targetName: string; scope: "single" | "all"; segmentIndex?: number }) => void;
  onSettled?: () => void;
}): ReactElement {
  const [selectedSpeakerId, setSelectedSpeakerId] = useState<string>("");
  const [customName, setCustomName] = useState<string>("");
  const [scope, setScope] = useState<"single" | "all">(segmentIndex !== undefined ? "single" : "all");
  const [adoptVoiceprint, setAdoptVoiceprint] = useState(true);
  const [saveToPeople, setSaveToPeople] = useState(true);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    let resolvedTargetName = "";
    let targetId: string | undefined = undefined;
    const localOnly = !saveToPeople;

    if (localOnly || selectedSpeakerId === "new" || !selectedSpeakerId) {
      if (!customName.trim()) {
        notify("warning", localOnly ? "Please enter a name to show in this transcript" : "Please enter a name for the new speaker");
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
        }
      })
      .catch((err) => {
        console.error("Async speaker reassignment network error:", err);
      })
      .finally(() => {
        onSettled?.();
      });
  };

  return (
    <Modal onClose={onClose} title={<>Assign Speaker: "{fromLabel}"</>} ariaLabel="Assign speaker" maxWidth="max-w-md">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wider text-base-content/70 mb-1.5">
            Name scope
          </label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setSaveToPeople(true)}
              className={`rounded-lg border px-3 py-2 text-xs font-semibold transition text-left ${
                saveToPeople
                  ? "border-primary bg-primary/20 text-primary"
                  : "border-base-300 bg-base-100 text-base-content/70 hover:text-base-content"
              }`}
            >
              <div className="font-bold">Save to People</div>
              <div className="text-[10px] text-base-content/70 font-normal mt-0.5">Recognize in future meetings</div>
            </button>
            <button
              type="button"
              onClick={() => setSaveToPeople(false)}
              className={`rounded-lg border px-3 py-2 text-xs font-semibold transition text-left ${
                !saveToPeople
                  ? "border-primary bg-primary/20 text-primary"
                  : "border-base-300 bg-base-100 text-base-content/70 hover:text-base-content"
              }`}
            >
              <div className="font-bold">This transcript only</div>
              <div className="text-[10px] text-base-content/70 font-normal mt-0.5">One-off name, not saved</div>
            </button>
          </div>
        </div>

        {segmentIndex !== undefined && (
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-base-content/70 mb-1.5">
              Apply Scope
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setScope("single")}
                className={`rounded-lg border px-3 py-2 text-xs font-semibold transition text-left ${
                  scope === "single"
                    ? "border-primary bg-primary/20 text-primary"
                    : "border-base-300 bg-base-100 text-base-content/70 hover:text-base-content"
                }`}
              >
                <div className="font-bold">This turn only</div>
                <div className="text-[10px] text-base-content/70 font-normal mt-0.5">Correct single turn</div>
              </button>
              <button
                type="button"
                onClick={() => setScope("all")}
                className={`rounded-lg border px-3 py-2 text-xs font-semibold transition text-left ${
                  scope === "all"
                    ? "border-primary bg-primary/20 text-primary"
                    : "border-base-300 bg-base-100 text-base-content/70 hover:text-base-content"
                }`}
              >
                <div className="font-bold">All "{fromLabel}" turns</div>
                <div className="text-[10px] text-base-content/70 font-normal mt-0.5">Batch rename all</div>
              </button>
            </div>
          </div>
        )}

        {!saveToPeople ? (
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-base-content/70 mb-1">
              Display Name
            </label>
            <input
              type="text"
              placeholder="e.g. Fred"
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              className="input input-md w-full"
            />
            <p className="mt-1.5 text-[11px] leading-snug text-base-content/50">
              Just relabels this transcript — nothing is added to People and no voiceprint is learned.
            </p>
          </div>
        ) : (
          <>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-base-content/70 mb-1">
                Select Person
              </label>
              <SpeakerCombobox
                value={selectedSpeakerId}
                onChange={setSelectedSpeakerId}
                knownSpeakers={knownSpeakers}
                emptyLabel="-- Create new or choose person --"
                createLabel="+ Create New Person"
                ariaLabel="Select person"
              />
            </div>

            {(selectedSpeakerId === "new" || !selectedSpeakerId) && (
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-base-content/70 mb-1">
                  Person Name
                </label>
                <input
                  type="text"
                  placeholder="e.g. Matt Cowger"
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  className="input input-md w-full"
                />
              </div>
            )}

            <div className="flex items-center gap-3 rounded-lg border border-base-300 bg-base-100/50 p-3">
              <input
                type="checkbox"
                id="voiceprint-toggle"
                checked={adoptVoiceprint}
                onChange={(e) => setAdoptVoiceprint(e.target.checked)}
                className="checkbox"
              />
              <label htmlFor="voiceprint-toggle" className="text-xs text-base-content leading-snug cursor-pointer">
                <span className="font-semibold text-base-content">Learn voiceprint from this audio</span>
                <br />
                Olive will automatically recognize and attribute this person in future meetings.
              </label>
            </div>
          </>
        )}

        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm font-medium text-base-content/70 hover:text-base-content"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary min-h-11"
          >
            Apply & Save
          </button>
        </div>
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
      ? customName || "New Speaker"
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
          notify("warning", "Please enter a name for the new speaker");
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
      notify("error", `Failed to split segment: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal onClose={onClose} title={<><span className="inline-flex items-center gap-1.5"><Scissors className="h-4 w-4 shrink-0" aria-hidden="true" /> Split Turn:</span> <span className="text-primary">{segment.speaker}</span></>} ariaLabel="Split turn" maxWidth="max-w-2xl">
      <p className="text-xs text-base-content/70">Click any word to choose where to split this turn into two separate segments.</p>
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Interactive Word Picker */}
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wider text-base-content/70 mb-2">
            Select Split Point (Click any word)
          </label>
          <div className="rounded-xl border border-base-300 bg-base-100 p-4 leading-loose flex flex-wrap gap-1.5 items-center max-h-56 overflow-y-auto">
            {words.map((word, idx) => {
              const isPart1 = idx < splitWordIndex;
              const isSplitTarget = idx === splitWordIndex;
              return (
                <Fragment key={idx}>
                  {isSplitTarget && (
                    <span className="badge badge-sm badge-warning gap-1 font-bold shadow-md animate-pulse">
                      <Scissors className="h-4 w-4 shrink-0" aria-hidden="true" /> Split Point
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => setSplitWordIndex(idx === 0 ? 1 : idx)}
                    className={`rounded px-1.5 py-0.5 text-xs font-medium transition cursor-pointer ${
                      isPart1
                        ? "bg-primary/20 text-primary border border-primary/40 hover:bg-primary/30"
                        : "bg-accent/20 text-accent border border-accent/40 hover:bg-accent/30"
                    }`}
                    title={`Click to split before "${word}"`}
                  >
                    {word}
                  </button>
                </Fragment>
              );
            })}
          </div>
        </div>

        {/* Split Comparison Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* Part 1 */}
          <div className="rounded-xl border border-primary/30 bg-primary/10 p-3.5 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-primary uppercase tracking-wide">
                Part 1 ({segment.speaker})
              </span>
              <span className="font-mono text-base-content/70 text-[11px]">
                {formatTimeOffset(segment.startMs)} → {formatTimeOffset(splitTimestamp)}
              </span>
            </div>
            <p className="text-xs text-base-content line-clamp-4 italic">
              "{part1Text || "(empty)"}"
            </p>
          </div>

          {/* Part 2 */}
          <div className="rounded-xl border border-accent/30 bg-accent/10 p-3.5 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-accent uppercase tracking-wide">
                Part 2 ({part2SpeakerName})
              </span>
              <span className="font-mono text-base-content/70 text-[11px]">
                {formatTimeOffset(splitTimestamp)} → {formatTimeOffset(segment.endMs)}
              </span>
            </div>
            <p className="text-xs text-base-content line-clamp-4 italic">
              "{part2Text || "(empty)"}"
            </p>
          </div>
        </div>

        {/* Reassign Part 2 Speaker */}
        <div className="space-y-3 pt-1 border-t border-base-300">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-base-content/70 mb-1">
              Speaker for Part 2
            </label>
            <SpeakerCombobox
              value={selectedSpeakerId}
              onChange={setSelectedSpeakerId}
              knownSpeakers={knownSpeakers}
              emptyLabel={`Keep as "${segment.speaker}"`}
              createLabel="+ Create New Person"
              ariaLabel="Speaker for Part 2"
            />
          </div>

          {selectedSpeakerId === "new" && (
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-base-content/70 mb-1">
                New Person Name
              </label>
              <input
                type="text"
                placeholder="e.g. Harrison"
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                className="input input-md w-full focus:border-accent"
              />
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm font-medium text-base-content/70 hover:text-base-content"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !part1Text || !part2Text}
            className="btn btn-warning min-h-11"
          >
            {submitting ? "Splitting…" : "Confirm & Split Turn"}
          </button>
        </div>
      </form>
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

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const selected = e.target.files[0];
      setFile(selected);
      if (!title.trim()) {
        setTitle(selected.name.replace(/\.[^/.]+$/, "").replace(/[_-]/g, " "));
      }
    }
  };

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) {
      notify("warning", "Please select an audio file to upload");
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
    <Modal onClose={onClose} title={"Upload Audio Recording"} ariaLabel="Upload audio recording" maxWidth="max-w-md">
      {error && <div className="rounded-xl border border-error bg-error/10 p-3 text-xs text-error">{error}</div>}

      <form onSubmit={handleUpload} className="space-y-4 text-sm">
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wider text-base-content/70 mb-1">
            Audio File (.m4a, .mp3, .wav, .aac, .ogg, .flac)
          </label>
          <input
            type="file"
            required
            accept="audio/*,.m4a,.mp3,.wav,.aac,.ogg,.flac,.webm"
            onChange={handleFileChange}
            className="file-input w-full p-2.5 text-base-content hover:file:bg-base-300"
          />
          {file && (
            <p className="mt-1 text-xs text-base-content/70">
              Selected: {file.name} ({(file.size / 1024 / 1024).toFixed(2)} MB)
            </p>
          )}
        </div>

        <div>
          <label className="block text-xs font-semibold uppercase tracking-wider text-base-content/70 mb-1">
            Meeting / Recording Title
          </label>
          <input
            type="text"
            placeholder="e.g. Planning Session with Team"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="input input-md w-full"
          />
        </div>

        <div className="space-y-2 rounded-lg border border-base-300 bg-base-100/50 p-3">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="auto-transcribe"
              checked={autoTranscribe}
              onChange={(e) => setAutoTranscribe(e.target.checked)}
              className="checkbox"
            />
            <label htmlFor="auto-transcribe" className="text-xs font-semibold text-base-content cursor-pointer">
              Automatically transcribe after upload
            </label>
          </div>

          {autoTranscribe && (
            <div className="pt-2 pl-6">
              <label className="block text-xs text-base-content/70 mb-1">Transcription Engine:</label>
              <Combobox
                value={selectedEngine}
                onChange={setSelectedEngine}
                placeholder="Select engine…"
                ariaLabel="Transcription engine"
                searchPlaceholder="Search engines…"
                options={ENGINE_OPTIONS}
              />
              <label className="block text-xs text-base-content/70 mb-1 mt-2">Language:</label>
              <Combobox
                value={transcriptionLanguage}
                onChange={setTranscriptionLanguage}
                placeholder="Select language…"
                ariaLabel="Transcription language"
                searchPlaceholder="Search languages…"
                options={languageOptions("Default from settings", TRANSCRIPTION_AUTO_LABEL)}
              />
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm text-base-content/70 hover:text-base-content"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={uploading || !file}
            className="btn btn-primary min-h-11"
          >
            {uploading ? "Ingesting…" : "Upload & Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
