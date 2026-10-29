import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import type { LlmModelCatalogItem, LlmProviderSummary, Template } from "../api/types.ts";
import { Button, notify } from "../components/ui";
import type { PlaudStatus } from "../lib/common";
import { BackupRestoreView } from "./Backup";
import {
  AiSection,
  isLlmDraftDirty,
  llmDraftErrors,
  llmDraftFrom,
  llmSavePayload,
  type LlmConfigDto,
  type LlmDraft,
} from "./settings/AiSection";
import { GeneralSection } from "./settings/GeneralSection";
import { IntegrationsSection, pollIntervalError } from "./settings/IntegrationsSection";
import { SpeakersSection } from "./settings/SpeakersSection";
import { TranscriptionSection } from "./settings/TranscriptionSection";
import { SaveBar, SectionHeader, errorText, readError, type AppConfigDto, type AppConfigKey } from "./settings/shared";

export type SettingsSection = "general" | "transcription" | "ai" | "speakers" | "integrations" | "data";

export const SETTINGS_SECTIONS: { key: SettingsSection; label: string }[] = [
  { key: "general", label: "General" },
  { key: "transcription", label: "Transcription" },
  { key: "ai", label: "AI models" },
  { key: "speakers", label: "Speaker recognition" },
  { key: "integrations", label: "Integrations" },
  { key: "data", label: "Data & backups" },
];

export function isSettingsSection(value: string): value is SettingsSection {
  return SETTINGS_SECTIONS.some((s) => s.key === value);
}

/** AppConfig fields each section owns (saved with that section's Save button). */
const SECTION_KEYS: Record<SettingsSection, AppConfigKey[]> = {
  general: ["defaultTranscriptionLanguage", "defaultSummaryLanguage"],
  transcription: [
    "transcriptionProvider",
    "retranscribePlaudWhenUnnamed",
    "alwaysRetranscribePlaud",
    "assemblyaiApiKey",
    "speechmaticsApiKey",
    "museApiKey",
    "modalTokenId",
    "modalTokenSecret",
    "modalAppName",
    "modalAsrModel",
  ],
  ai: [],
  speakers: ["hfToken", "localClusteringThreshold", "localSimilarityThreshold"],
  integrations: ["pollIntervalMinutes"],
  data: [],
};

function changedKeys(saved: AppConfigDto, draft: AppConfigDto, keys: AppConfigKey[]): AppConfigKey[] {
  return keys.filter((k) => !Object.is(saved[k], draft[k]));
}

function defaultTemplateIdOf(templates: Template[] | null): string {
  return templates?.find((t) => t.isDefault)?.id ?? "";
}

export function SettingsView({
  section,
  onNavigateSection,
  plaudStatus,
  onRefreshPlaud,
  onSettingsSaved,
  onRestoreComplete,
}: {
  section: SettingsSection;
  onNavigateSection: (section: SettingsSection) => void;
  plaudStatus: PlaudStatus | null;
  onRefreshPlaud: () => void;
  onSettingsSaved: () => void;
  onRestoreComplete: () => void;
}): ReactElement {
  const [config, setConfig] = useState<AppConfigDto | null>(null);
  const [draft, setDraft] = useState<AppConfigDto | null>(null);
  const [llmConfig, setLlmConfig] = useState<LlmConfigDto | null>(null);
  const [llmDraft, setLlmDraft] = useState<LlmDraft | null>(null);
  const [providers, setProviders] = useState<LlmProviderSummary[]>([]);
  const [models, setModels] = useState<LlmModelCatalogItem[]>([]);
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [templateDraft, setTemplateDraft] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const loadCatalog = useCallback(async () => {
    const [provRes, modelsRes] = await Promise.all([fetch("/api/llm/providers"), fetch("/api/llm/models")]);
    if (provRes.ok) setProviders(((await provRes.json()) as { providers?: LlmProviderSummary[] }).providers ?? []);
    if (modelsRes.ok) setModels(((await modelsRes.json()) as { models?: LlmModelCatalogItem[] }).models ?? []);
  }, []);

  const loadTemplates = useCallback(async () => {
    try {
      const res = await fetch("/api/templates");
      if (!res.ok) throw new Error();
      const list = ((await res.json()) as { templates?: Template[] }).templates ?? [];
      setTemplates(list);
      setTemplateDraft(defaultTemplateIdOf(list));
    } catch {
      setTemplates([]);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [cfgRes, llmRes] = await Promise.all([fetch("/api/config"), fetch("/api/llm/config")]);
      if (!cfgRes.ok) throw new Error(await readError(cfgRes, "Could not load settings"));
      if (!llmRes.ok) throw new Error(await readError(llmRes, "Could not load AI settings"));
      const cfg = (await cfgRes.json()) as AppConfigDto;
      const llm = (await llmRes.json()) as LlmConfigDto;
      setConfig(cfg);
      setDraft(cfg);
      setLlmConfig(llm);
      setLlmDraft(llmDraftFrom(llm));
      await Promise.all([loadCatalog(), loadTemplates()]);
    } catch (err) {
      setLoadError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [loadCatalog, loadTemplates]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirtyBySection = useMemo(() => {
    const result = {} as Record<SettingsSection, boolean>;
    for (const s of SETTINGS_SECTIONS) {
      result[s.key] = !!config && !!draft && changedKeys(config, draft, SECTION_KEYS[s.key]).length > 0;
    }
    result.general ||= templateDraft !== defaultTemplateIdOf(templates);
    result.ai = !!llmConfig && !!llmDraft && isLlmDraftDirty(llmConfig, llmDraft);
    return result;
  }, [config, draft, llmConfig, llmDraft, templateDraft, templates]);

  const anyDirty = Object.values(dirtyBySection).some(Boolean);

  // Warn before leaving the page with unsaved edits.
  useEffect(() => {
    if (!anyDirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [anyDirty]);

  const setField = useCallback(<K extends keyof AppConfigDto>(key: K, value: AppConfigDto[K]) => {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
  }, []);

  const setLlm = useCallback((updater: (prev: LlmDraft) => LlmDraft) => {
    setLlmDraft((prev) => (prev ? updater(prev) : prev));
  }, []);

  const validationError = (s: SettingsSection): string | null => {
    if (!draft) return null;
    if (s === "integrations") return pollIntervalError(draft.pollIntervalMinutes) ? "Fix the check interval before saving." : null;
    if (s === "ai" && llmDraft) return llmDraftErrors(llmDraft);
    return null;
  };

  const discard = (s: SettingsSection) => {
    if (s === "ai") {
      if (llmConfig) setLlmDraft(llmDraftFrom(llmConfig));
      return;
    }
    if (config) {
      setDraft((prev) => {
        if (!prev) return prev;
        const next = { ...prev } as Record<string, unknown>;
        for (const k of SECTION_KEYS[s]) next[k] = config[k];
        return next as unknown as AppConfigDto;
      });
    }
    if (s === "general") setTemplateDraft(defaultTemplateIdOf(templates));
  };

  const saveAppConfig = async (keys: AppConfigKey[]) => {
    if (!config || !draft) return;
    const patch = Object.fromEntries(changedKeys(config, draft, keys).map((k) => [k, draft[k]]));
    if (Object.keys(patch).length === 0) return;
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(await readError(res, "Could not save settings"));
    const data = (await res.json()) as { config: AppConfigDto };
    setConfig(data.config);
    // Adopt the server's (masked) values for the saved keys; keep other sections' edits.
    setDraft((prev) => {
      const next = { ...(prev ?? data.config) } as Record<string, unknown>;
      for (const k of keys) next[k] = data.config[k];
      for (const k of Object.keys(data.config)) if (k.startsWith("has")) next[k] = (data.config as unknown as Record<string, unknown>)[k];
      return next as unknown as AppConfigDto;
    });
  };

  const save = async (s: SettingsSection) => {
    if (validationError(s)) return;
    setSaving(true);
    try {
      if (s === "ai") {
        if (!llmDraft) return;
        const res = await fetch("/api/llm/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(llmSavePayload(llmDraft, models)),
        });
        if (!res.ok) throw new Error(await readError(res, "Could not save AI settings"));
        const llmRes = await fetch("/api/llm/config");
        if (llmRes.ok) {
          const llm = (await llmRes.json()) as LlmConfigDto;
          setLlmConfig(llm);
          setLlmDraft(llmDraftFrom(llm));
        }
        await loadCatalog();
      } else {
        await saveAppConfig(SECTION_KEYS[s]);
        if (s === "general" && templateDraft && templateDraft !== defaultTemplateIdOf(templates)) {
          const res = await fetch(`/api/templates/${encodeURIComponent(templateDraft)}/default`, { method: "POST" });
          if (!res.ok) throw new Error(await readError(res, "Could not set the default template"));
          await loadTemplates();
        }
      }
      notify("success", "Settings saved");
      onSettingsSaved();
    } catch (err) {
      notify("error", errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const sectionMeta = SETTINGS_SECTIONS.find((s) => s.key === section) ?? SETTINGS_SECTIONS[0];

  let body: ReactElement;
  if (section === "data") {
    body = (
      <section aria-labelledby="settings-data">
        <SectionHeader
          id="settings-data"
          title="Data & backups"
          description="A backup holds the database, settings, templates, transcripts, summaries and every audio file."
        />
        <BackupRestoreView onRestoreComplete={onRestoreComplete} />
      </section>
    );
  } else if (loading && !config) {
    body = (
      <div className="flex flex-col gap-3" aria-busy="true">
        <SectionHeader id="settings-loading" title={sectionMeta.label} description="Loading settings…" />
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-14 animate-pulse rounded-lg bg-hover" />
        ))}
      </div>
    );
  } else if (loadError || !config || !draft || !llmConfig || !llmDraft) {
    body = (
      <div className="flex flex-col items-start gap-3">
        <SectionHeader id="settings-error" title={sectionMeta.label} description="Settings could not be loaded." />
        <p role="alert" className="text-sm text-error">
          {loadError ?? "Unknown error"}
        </p>
        <Button size="sm" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    );
  } else {
    body = (
      <>
        {section === "general" && (
          <GeneralSection
            draft={draft}
            onChange={setField}
            templates={templates}
            defaultTemplateId={templateDraft}
            onDefaultTemplateChange={setTemplateDraft}
          />
        )}
        {section === "transcription" && (
          <TranscriptionSection draft={draft} saved={config} onChange={setField} onOpenSpeakers={() => onNavigateSection("speakers")} />
        )}
        {section === "ai" && (
          <AiSection saved={llmConfig} draft={llmDraft} setDraft={setLlm} providers={providers} models={models} onCatalogChanged={loadCatalog} />
        )}
        {section === "speakers" && (
          <SpeakersSection draft={draft} saved={config} onChange={setField} onLibraryChanged={onRestoreComplete} />
        )}
        {section === "integrations" && (
          <IntegrationsSection plaudStatus={plaudStatus} onRefreshPlaud={onRefreshPlaud} draft={draft} onChange={setField} />
        )}
        <SaveBar
          dirty={dirtyBySection[section]}
          saving={saving}
          disabled={!!validationError(section)}
          message={validationError(section) ?? undefined}
          onSave={() => void save(section)}
          onDiscard={() => discard(section)}
        />
      </>
    );
  }

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:gap-10">
      <nav
        aria-label="Settings sections"
        className="-mx-4 flex gap-1 overflow-x-auto border-b border-divider px-4 pb-2 [scrollbar-width:none] sm:-mx-8 sm:px-8 lg:sticky lg:top-10 lg:mx-0 lg:w-52 lg:shrink-0 lg:flex-col lg:gap-0.5 lg:border-0 lg:px-0 lg:pb-0"
      >
        {SETTINGS_SECTIONS.map((s) => {
          const current = section === s.key;
          return (
            <button
              key={s.key}
              type="button"
              aria-current={current ? "page" : undefined}
              onClick={() => onNavigateSection(s.key)}
              className={`flex h-[34px] shrink-0 items-center justify-between gap-2 rounded-md px-2.5 text-left text-sm whitespace-nowrap max-lg:min-h-11 ${
                current ? "bg-active font-semibold" : "text-base-content/75 hover:bg-hover hover:text-base-content"
              }`}
            >
              {s.label}
              {dirtyBySection[s.key] && (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--tag-orange)]" title="Unsaved changes">
                  <span className="sr-only">(unsaved changes)</span>
                </span>
              )}
            </button>
          );
        })}
      </nav>
      <div className="min-w-0 max-w-[760px] flex-1">{body}</div>
    </div>
  );
}
