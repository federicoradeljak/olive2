import { useMemo, useState } from "react";
import type { ReactElement } from "react";
import { ChevronDown, Plus, RefreshCw, Search, Trash2, Zap } from "lucide-react";
import { Combobox } from "../../components/Combobox";
import { ThinkingLabel, llmProviderOptions, modelOptions, thinkingLevelOptions } from "../../components/OptionComboboxes";
import { Button, notify } from "../../components/ui";
import type { LlmModelCatalogItem, LlmProviderSummary } from "../../api/types.ts";
import { ChatGptPlanRow } from "./ChatGptPlanRow";
import { GroupTitle, INPUT_CLASS, Panel, SectionHeader, StatusTag, errorText, readError } from "./shared";

/** Provider id of the ChatGPT plan (sign-in instead of an API key). */
export const CHATGPT_PLAN_PROVIDER = "chatgpt-plan";
/** Chat provider option meaning "use the default model". */
const SAME_AS_DEFAULT = "";

export interface LlmCustomModel {
  id: string;
  name: string;
  provider: string;
  api?: string | null;
  baseUrl?: string | null;
  contextWindow?: number | null;
  maxTokens?: number | null;
  reasoning?: boolean | null;
}

/** GET /api/llm/config (API keys are reduced to hasApiKey). */
export interface LlmConfigDto {
  defaultProvider: string;
  defaultModel: string;
  defaultThinkingLevel: string;
  providers: Record<string, { hasApiKey?: boolean; baseUrl?: string; headers?: Record<string, string> }>;
  customModels: LlmCustomModel[];
  chatProvider?: string | null;
  chatModel?: string | null;
}

export interface LlmDraft {
  defaultProvider: string;
  defaultModel: string;
  defaultThinkingLevel: string;
  /** Only providers the user touched: a new API key (blank keeps the saved one) and the base URL. */
  providerEdits: Record<string, { apiKey: string; baseUrl: string }>;
  customModels: LlmCustomModel[];
  /** Meeting chat model; an empty provider means "same as the default model". */
  chatProvider: string;
  chatModel: string;
}

export function llmDraftFrom(cfg: LlmConfigDto): LlmDraft {
  return {
    defaultProvider: cfg.defaultProvider,
    defaultModel: cfg.defaultModel,
    defaultThinkingLevel: cfg.defaultThinkingLevel || "off",
    providerEdits: {},
    customModels: cfg.customModels ?? [],
    chatProvider: cfg.chatProvider ?? SAME_AS_DEFAULT,
    chatModel: cfg.chatModel ?? "",
  };
}

export function isLlmDraftDirty(saved: LlmConfigDto, draft: LlmDraft): boolean {
  if (draft.defaultProvider !== saved.defaultProvider || draft.defaultModel !== saved.defaultModel) return true;
  if (draft.defaultThinkingLevel !== (saved.defaultThinkingLevel || "off")) return true;
  if (draft.chatProvider !== (saved.chatProvider ?? SAME_AS_DEFAULT) || draft.chatModel !== (saved.chatModel ?? "")) return true;
  for (const [id, edit] of Object.entries(draft.providerEdits)) {
    if (edit.apiKey.trim()) return true;
    if (edit.baseUrl.trim() !== (saved.providers[id]?.baseUrl ?? "")) return true;
  }
  return JSON.stringify(draft.customModels) !== JSON.stringify(saved.customModels ?? []);
}

export function baseUrlError(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "Use an http:// or https:// address.";
    return null;
  } catch {
    return "Enter a full address, for example http://localhost:11434/v1.";
  }
}

export function llmDraftErrors(draft: LlmDraft): string | null {
  for (const edit of Object.values(draft.providerEdits)) {
    if (baseUrlError(edit.baseUrl)) return "Fix the highlighted base URL before saving.";
  }
  if (draft.chatProvider && !draft.chatModel) return "Pick a model for meeting chat, or set it back to the default model.";
  return null;
}

/** Thinking level stored for the default model: "off" when it cannot reason. */
export function effectiveThinkingLevel(draft: LlmDraft, models: LlmModelCatalogItem[]): string {
  const m = models.find((x) => x.provider === draft.defaultProvider && x.id === draft.defaultModel);
  return m?.reasoning ? draft.defaultThinkingLevel : "off";
}

/** POST /api/llm/config body for the draft. */
export function llmSavePayload(draft: LlmDraft, models: LlmModelCatalogItem[]): Record<string, unknown> {
  const providers: Record<string, { apiKey?: string; baseUrl: string }> = {};
  for (const [id, edit] of Object.entries(draft.providerEdits)) {
    providers[id] = { ...(edit.apiKey.trim() ? { apiKey: edit.apiKey.trim() } : {}), baseUrl: edit.baseUrl.trim() };
  }
  return {
    defaultProvider: draft.defaultProvider,
    defaultModel: draft.defaultModel,
    defaultThinkingLevel: effectiveThinkingLevel(draft, models),
    providers,
    customModels: draft.customModels,
    chatProvider: draft.chatProvider || null,
    chatModel: draft.chatProvider ? draft.chatModel || null : null,
  };
}

const API_OPTIONS = [
  { value: "openai-completions", label: "OpenAI-compatible", description: "openai-completions" },
  { value: "anthropic-messages", label: "Anthropic Messages", description: "anthropic-messages" },
  { value: "google-generative-ai", label: "Google Generative AI", description: "google-generative-ai" },
];

const LABEL = "text-[13px] font-medium text-base-content/70";

function ProviderRow({
  provider,
  saved,
  edit,
  onEdit,
}: {
  provider: LlmProviderSummary;
  saved: LlmConfigDto["providers"][string] | undefined;
  edit: { apiKey: string; baseUrl: string } | undefined;
  onEdit: (edit: { apiKey: string; baseUrl: string }) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const current = edit ?? { apiKey: "", baseUrl: saved?.baseUrl ?? "" };
  const urlError = baseUrlError(current.baseUrl);
  const keySource = saved?.hasApiKey ? "key saved in Olive" : provider.isConfigured ? "key from environment" : "no key";
  const meta = [`${provider.modelCount} models`, keySource, current.baseUrl.trim() ? current.baseUrl.trim() : null].filter(Boolean).join(" · ");
  const changed = !!edit && (edit.apiKey.trim() !== "" || edit.baseUrl.trim() !== (saved?.baseUrl ?? ""));
  const panelId = `provider-${provider.id}`;

  return (
    <li className="border-b border-divider last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-3">
        <span className="flex min-w-0 flex-[1_1_12rem] flex-col">
          <span className="font-medium">
            {provider.name}
            {changed && <span className="ml-2 text-xs font-normal text-[color:var(--tag-orange)]">Edited</span>}
          </span>
          <span className="truncate text-xs text-base-content/60" title={meta}>
            {meta}
          </span>
        </span>
        {provider.isConfigured ? (
          <StatusTag tone="green">Ready</StatusTag>
        ) : provider.hasCustomBaseUrl ? (
          <StatusTag tone="blue">Custom URL</StatusTag>
        ) : (
          <StatusTag tone="yellow">Needs key</StatusTag>
        )}
        <Button size="sm" variant="secondary" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((v) => !v)}>
          {open ? "Close" : provider.isConfigured ? "Edit" : "Add key"}
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
        </Button>
      </div>
      {open && (
        <div id={panelId} className="grid grid-cols-1 gap-3 px-3.5 pb-4 sm:grid-cols-2">
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className={LABEL}>API key</span>
            <input
              type="password"
              value={current.apiKey}
              onChange={(e) => onEdit({ ...current, apiKey: e.target.value })}
              placeholder={provider.isConfigured ? "Leave blank to keep the current key" : "Paste API key"}
              autoComplete="off"
              spellCheck={false}
              className={`${INPUT_CLASS} font-mono`}
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className={LABEL}>Base URL (optional)</span>
            <input
              type="url"
              value={current.baseUrl}
              onChange={(e) => onEdit({ ...current, baseUrl: e.target.value })}
              placeholder="http://localhost:11434/v1"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={!!urlError}
              className={`${INPUT_CLASS} font-mono ${urlError ? "border-error!" : ""}`}
            />
            {urlError ? (
              <span role="alert" className="text-xs text-error">
                {urlError}
              </span>
            ) : (
              <span className="text-xs text-base-content/60">For Ollama, LiteLLM or another compatible proxy.</span>
            )}
          </label>
        </div>
      )}
    </li>
  );
}

interface CustomForm {
  id: string;
  name: string;
  provider: string;
  api: string;
  baseUrl: string;
  contextWindow: string;
  reasoning: boolean;
}

const EMPTY_CUSTOM: CustomForm = { id: "", name: "", provider: "", api: "openai-completions", baseUrl: "", contextWindow: "", reasoning: false };

function customFormErrors(form: CustomForm, existing: LlmCustomModel[]): Partial<Record<keyof CustomForm, string>> {
  const errors: Partial<Record<keyof CustomForm, string>> = {};
  if (!form.id.trim()) errors.id = "Required.";
  if (!form.provider.trim()) errors.provider = "Required.";
  if (form.id.trim() && form.provider.trim() && existing.some((m) => m.id === form.id.trim() && m.provider === form.provider.trim())) {
    errors.id = "This provider already has a custom model with that ID.";
  }
  const url = baseUrlError(form.baseUrl);
  if (url) errors.baseUrl = url;
  if (form.contextWindow.trim()) {
    const n = Number(form.contextWindow);
    if (!Number.isInteger(n) || n <= 0) errors.contextWindow = "Use a whole number of tokens.";
  }
  return errors;
}

function CustomModels({
  models,
  providers,
  onChange,
}: {
  models: LlmCustomModel[];
  providers: LlmProviderSummary[];
  onChange: (models: LlmCustomModel[]) => void;
}): ReactElement {
  const [form, setForm] = useState<CustomForm | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const errors = form ? customFormErrors(form, models) : {};
  const shownErrors = submitted ? errors : {};

  const add = () => {
    if (!form) return;
    setSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    const ctx = form.contextWindow.trim() ? Number(form.contextWindow) : undefined;
    const model: LlmCustomModel = {
      id: form.id.trim(),
      name: form.name.trim() || form.id.trim(),
      provider: form.provider.trim(),
      api: form.api,
      ...(form.baseUrl.trim() ? { baseUrl: form.baseUrl.trim() } : {}),
      ...(ctx ? { contextWindow: ctx } : {}),
      reasoning: form.reasoning,
    };
    onChange([...models, model]);
    setForm(null);
    setSubmitted(false);
  };

  const field = (key: "id" | "name" | "provider" | "baseUrl" | "contextWindow", label: string, placeholder: string, extra: Record<string, unknown> = {}) =>
    form && (
      <label className="flex min-w-0 flex-col gap-1.5">
        <span className={LABEL}>{label}</span>
        <input
          type="text"
          value={form[key]}
          onChange={(e) => setForm({ ...form, [key]: e.target.value })}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={!!shownErrors[key]}
          className={`${INPUT_CLASS} ${shownErrors[key] ? "border-error!" : ""}`}
          {...extra}
        />
        {shownErrors[key] && (
          <span role="alert" className="text-xs text-error">
            {shownErrors[key]}
          </span>
        )}
      </label>
    );

  return (
    <div className="flex flex-col gap-3">
      {models.length > 0 && (
        <ul className="rounded-[10px] border border-base-content/12">
          {models.map((m, i) => (
            <li key={`${m.provider}:${m.id}`} className="flex items-center gap-3 border-b border-divider px-3.5 py-2.5 last:border-b-0">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">{m.name}</span>
                <span className="truncate text-xs text-base-content/60">
                  {[m.provider, m.id, m.baseUrl, m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k context` : null, m.reasoning ? "reasoning" : null]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              <Button
                size="sm"
                variant="ghost"
                square
                aria-label={`Remove ${m.name}`}
                onClick={() => onChange(models.filter((_, j) => j !== i))}
                className="text-base-content/60 hover:text-error"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {form ? (
        <Panel>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {field("id", "Model ID", "llama3.1:8b")}
            {field("name", "Display name (optional)", "Llama 3.1 8B")}
            {field("provider", "Provider", "ollama", { list: "custom-model-providers" })}
            <div className="flex min-w-0 flex-col gap-1.5">
              <span className={LABEL}>API style</span>
              <Combobox value={form.api} onChange={(v) => setForm({ ...form, api: v })} ariaLabel="API style" options={API_OPTIONS} />
            </div>
            {field("baseUrl", "Base URL (optional)", "http://localhost:11434/v1", { type: "url" })}
            {field("contextWindow", "Context window (optional)", "128000", { inputMode: "numeric" })}
          </div>
          <datalist id="custom-model-providers">
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </datalist>
          <label className="flex items-center gap-2.5 max-sm:min-h-11">
            <input
              type="checkbox"
              checked={form.reasoning}
              onChange={(e) => setForm({ ...form, reasoning: e.target.checked })}
              className="checkbox checkbox-sm checkbox-primary rounded"
            />
            <span>Supports thinking (reasoning)</span>
          </label>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setForm(null);
                setSubmitted(false);
              }}
            >
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={add}>
              Add model
            </Button>
          </div>
        </Panel>
      ) : (
        <div>
          <Button size="sm" variant="ghost" onClick={() => setForm({ ...EMPTY_CUSTOM })} className="text-base-content/70">
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Add custom model
          </Button>
        </div>
      )}
    </div>
  );
}

export function AiSection({
  saved,
  draft,
  setDraft,
  providers,
  models,
  onCatalogChanged,
}: {
  saved: LlmConfigDto;
  draft: LlmDraft;
  setDraft: (updater: (prev: LlmDraft) => LlmDraft) => void;
  providers: LlmProviderSummary[];
  models: LlmModelCatalogItem[];
  onCatalogChanged: () => Promise<void>;
}): ReactElement {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string; durationMs?: number } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState("");

  const providerModels = useMemo(() => models.filter((m) => m.provider === draft.defaultProvider), [models, draft.defaultProvider]);
  const selectedModel = providerModels.find((m) => m.id === draft.defaultModel);
  // Chat can use any provider with a key, plus the ChatGPT plan once signed in.
  const chatProviderOptions = useMemo(
    () => [
      { value: SAME_AS_DEFAULT, label: "Same as default model", description: "Chat uses the default model above" },
      ...llmProviderOptions(providers.filter((p) => p.isConfigured || p.id === draft.chatProvider)),
    ],
    [providers, draft.chatProvider],
  );
  const chatModels = useMemo(() => models.filter((m) => m.provider === draft.chatProvider), [models, draft.chatProvider]);

  const sortedProviders = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return providers
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q))
      .sort((a, b) => Number(b.isConfigured) - Number(a.isConfigured) || a.name.localeCompare(b.name));
  }, [providers, filter]);

  const setProvider = (id: string) => {
    setTestResult(null);
    setDraft((prev) => {
      const first = models.find((m) => m.provider === id);
      if (!first) return { ...prev, defaultProvider: id };
      const levels = first.supportedThinkingLevels ?? ["low", "medium", "high"];
      return { ...prev, defaultProvider: id, defaultModel: first.id, defaultThinkingLevel: levels.includes("off") ? "off" : levels[0] ?? "low" };
    });
  };

  const setModel = (id: string) => {
    setTestResult(null);
    setDraft((prev) => {
      const m = models.find((x) => x.provider === prev.defaultProvider && x.id === id);
      const levels = m?.supportedThinkingLevels as string[] | undefined;
      const level = levels && !levels.includes(prev.defaultThinkingLevel) ? levels[0] ?? "low" : prev.defaultThinkingLevel;
      return { ...prev, defaultModel: id, defaultThinkingLevel: level };
    });
  };

  const setChatProvider = (id: string) =>
    setDraft((prev) => ({ ...prev, chatProvider: id, chatModel: id ? (models.find((m) => m.provider === id)?.id ?? "") : "" }));

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    const edit = draft.providerEdits[draft.defaultProvider];
    const baseUrl = edit ? edit.baseUrl : saved.providers[draft.defaultProvider]?.baseUrl ?? "";
    try {
      const res = await fetch("/api/llm/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: draft.defaultProvider,
          model: draft.defaultModel,
          apiKey: edit?.apiKey.trim() || undefined,
          baseUrl: baseUrl.trim() || undefined,
          thinkingLevel: selectedModel?.reasoning ? draft.defaultThinkingLevel : undefined,
        }),
      });
      const data = (await res.json()) as { ok?: boolean; response?: string; error?: string; durationMs?: number };
      if (res.ok && data.ok) {
        setTestResult({ ok: true, message: `Connected. The model replied "${(data.response ?? "").slice(0, 80)}".`, durationMs: data.durationMs });
      } else {
        setTestResult({ ok: false, message: data.error || "Connection failed." });
      }
    } catch (err) {
      setTestResult({ ok: false, message: errorText(err) });
    } finally {
      setTesting(false);
    }
  };

  const refreshCatalog = async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/llm/refresh-catalog", { method: "POST" });
      if (!res.ok) throw new Error(await readError(res, "Refresh failed"));
      await onCatalogChanged();
      notify("success", "Model catalog refreshed");
    } catch (err) {
      notify("error", `Could not refresh the model catalog: ${errorText(err)}`);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <section aria-labelledby="settings-ai">
      <SectionHeader
        id="settings-ai"
        title="AI models"
        description="The default model writes summaries and suggested titles, and answers meeting chat unless you pick a chat model. Each summary can still pick another model."
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className={LABEL}>Default provider</span>
          <Combobox
            value={draft.defaultProvider}
            onChange={setProvider}
            ariaLabel="Default AI provider"
            placeholder="Select provider…"
            searchPlaceholder="Search providers…"
            options={llmProviderOptions(providers)}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className={LABEL}>Default model</span>
          <Combobox
            value={draft.defaultModel}
            onChange={setModel}
            ariaLabel="Default model"
            placeholder={providerModels.length ? "Select model…" : "No models for this provider"}
            searchPlaceholder="Search models…"
            emptyText="No models match your search."
            options={modelOptions(providerModels)}
          />
        </div>
        {selectedModel?.reasoning && (
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className={LABEL}>
              <ThinkingLabel />
            </span>
            <Combobox
              value={draft.defaultThinkingLevel}
              onChange={(v) => setDraft((prev) => ({ ...prev, defaultThinkingLevel: v }))}
              ariaLabel="Default thinking level"
              placeholder="Select thinking level…"
              options={thinkingLevelOptions(selectedModel.supportedThinkingLevels ?? ["low", "medium", "high"])}
            />
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button size="sm" onClick={() => void test()} disabled={testing || !draft.defaultModel}>
          {testing ? <span className="loading loading-spinner loading-xs" aria-hidden="true" /> : <Zap className="h-3.5 w-3.5" aria-hidden="true" />}
          {testing ? "Testing…" : "Test connection"}
        </Button>
        {testResult && (
          <span role="status" className={`min-w-0 flex-1 text-[13px] ${testResult.ok ? "text-[color:var(--tag-green)]" : "text-error"}`}>
            {testResult.message}
            {testResult.ok && testResult.durationMs ? <span className="text-base-content/50"> · {testResult.durationMs} ms</span> : null}
          </span>
        )}
      </div>
      <p className="mt-1.5 text-xs text-base-content/60">Tests the provider and model above, using any key or URL you typed below even before saving.</p>

      <GroupTitle>Meeting chat</GroupTitle>
      <p className="mb-2 text-[13px] text-base-content/65">Lists providers with a key, and your ChatGPT plan once it is connected below.</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className={LABEL}>Chat provider</span>
          <Combobox
            value={draft.chatProvider}
            onChange={setChatProvider}
            ariaLabel="Meeting chat provider"
            placeholder="Same as default model"
            searchPlaceholder="Search providers…"
            options={chatProviderOptions}
          />
        </div>
        {draft.chatProvider && (
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className={LABEL}>Chat model</span>
            <Combobox
              value={draft.chatModel}
              onChange={(v) => setDraft((prev) => ({ ...prev, chatModel: v }))}
              ariaLabel="Meeting chat model"
              placeholder={chatModels.length ? "Select model…" : "No models for this provider"}
              searchPlaceholder="Search models…"
              emptyText="No models match your search."
              options={modelOptions(chatModels)}
            />
          </div>
        )}
      </div>

      <GroupTitle
        action={
          <Button size="sm" variant="ghost" onClick={() => void refreshCatalog()} disabled={refreshing} className="text-base-content/70">
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} aria-hidden="true" />
            {refreshing ? "Refreshing…" : "Refresh model catalog"}
          </Button>
        }
      >
        Providers
      </GroupTitle>
      <p className="mb-2 text-[13px] text-base-content/65">Keys from environment variables are used automatically. A key saved here replaces it.</p>
      {providers.length > 8 && (
        <label className="mb-2 flex h-9 items-center gap-2 rounded-md border border-base-content/15 px-2.5 focus-within:border-primary/60 max-sm:h-11">
          <Search className="h-3.5 w-3.5 text-base-content/50" aria-hidden="true" />
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter providers"
            aria-label="Filter providers"
            className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
        </label>
      )}
      <ul className="rounded-[10px] border border-base-content/12">
        {sortedProviders.length === 0 ? (
          <li className="px-3.5 py-6 text-center text-sm text-base-content/60">No providers match.</li>
        ) : (
          sortedProviders.map((p) =>
            p.id === CHATGPT_PLAN_PROVIDER ? (
              <ChatGptPlanRow key={p.id} provider={p} onChanged={onCatalogChanged} />
            ) : (
              <ProviderRow
                key={p.id}
                provider={p}
                saved={saved.providers[p.id]}
                edit={draft.providerEdits[p.id]}
                onEdit={(edit) => setDraft((prev) => ({ ...prev, providerEdits: { ...prev.providerEdits, [p.id]: edit } }))}
              />
            ),
          )
        )}
      </ul>

      <GroupTitle>Custom models</GroupTitle>
      <p className="mb-2 text-[13px] text-base-content/65">Models missing from the catalog, such as local Ollama models or a private deployment.</p>
      <CustomModels models={draft.customModels} providers={providers} onChange={(customModels) => setDraft((prev) => ({ ...prev, customModels }))} />
    </section>
  );
}
