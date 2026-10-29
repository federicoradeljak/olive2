import React, { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { Mic, Save, Settings, Zap } from "lucide-react";
import { Combobox } from "../components/Combobox";
import { notify } from "../components/ui";
import { MODAL_ASR_MODEL_OPTIONS, type ModalAsrModel, PLAUD_RETRANSCRIBE_OPTIONS, SUMMARY_AUTO_LABEL, TRANSCRIBE_PROVIDER_OPTIONS, TRANSCRIPTION_AUTO_LABEL, ThinkingLabel, languageOptions, llmProviderOptions, modelOptions, thinkingLevelOptions } from "../components/OptionComboboxes";
import type { LlmModelCatalogItem, LlmProviderSummary, Speaker, Template } from "../api/types.ts";
import { Modal } from "./AppModals";

export function LlmSettingsModal({
  onClose,
  onSaved
}: {
  onClose: () => void;
  onSaved: () => void;
}): ReactElement {
  const [providers, setProviders] = useState<LlmProviderSummary[]>([]);
  const [models, setModels] = useState<LlmModelCatalogItem[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<string>("google");
  const [selectedModel, setSelectedModel] = useState<string>("gemini-2.5-flash");
  const [thinkingLevel, setThinkingLevel] = useState<string>("off");
  const [apiKey, setApiKey] = useState<string>("");
  const [baseUrl, setBaseUrl] = useState<string>("");
  const [savedProviders, setSavedProviders] = useState<Record<string, { hasApiKey?: boolean; baseUrl?: string }>>({});
  const [localClusteringThreshold, setLocalClusteringThreshold] = useState<number>(0.50);
  const [localSimilarityThreshold, setLocalSimilarityThreshold] = useState<number>(0.45);
  const [localAsrModel, setLocalAsrModel] = useState<string>("onnx-community/cohere-transcribe-03-2026-ONNX");
  const [transcriptionProvider, setTranscriptionProvider] = useState<"speechmatics" | "local" | "assemblyai" | "muse" | "modal">("local");
  const [plaudRetranscribeMode, setPlaudRetranscribeMode] = useState<"off" | "unnamed" | "always">("off");
  const [defaultTranscriptionLanguage, setDefaultTranscriptionLanguage] = useState("");
  const [defaultSummaryLanguage, setDefaultSummaryLanguage] = useState("");
  const [hfToken, setHfToken] = useState<string>("");
  const [speechmaticsApiKey, setSpeechmaticsApiKey] = useState<string>("");
  const [assemblyaiApiKey, setAssemblyaiApiKey] = useState<string>("");
  const [museApiKey, setMuseApiKey] = useState<string>("");
  const [modalTokenId, setModalTokenId] = useState<string>("");
  const [modalTokenSecret, setModalTokenSecret] = useState<string>("");
  const [modalAppName, setModalAppName] = useState<string>("olive-gpu");
  const [settingsModalAsrModel, setSettingsModalAsrModel] = useState<ModalAsrModel>("cohere");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshingCatalog, setRefreshingCatalog] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message?: string; durationMs?: number } | null>(null);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [configRes, provRes, modelsRes, appCfgRes] = await Promise.all([
        fetch("/api/llm/config"),
        fetch("/api/llm/providers"),
        fetch("/api/llm/models"),
        fetch("/api/config")
      ]);

      if (configRes.ok) {
        const config = await configRes.json();
        setSelectedProvider(config.defaultProvider || "google");
        setSelectedModel(config.defaultModel || "gemini-2.5-flash");
        if (config.defaultThinkingLevel) {
          setThinkingLevel(config.defaultThinkingLevel);
        }
        setSavedProviders(config.providers || {});
        const provConfig = config.providers?.[config.defaultProvider || "google"];
        setBaseUrl(provConfig?.baseUrl || "");
      }

      if (appCfgRes.ok) {
        const appCfg = await appCfgRes.json();
        if (appCfg.localClusteringThreshold !== undefined) {
          setLocalClusteringThreshold(appCfg.localClusteringThreshold);
        }
        if (appCfg.localSimilarityThreshold !== undefined) {
          setLocalSimilarityThreshold(appCfg.localSimilarityThreshold);
        }
        if (appCfg.localAsrModel !== undefined) {
          setLocalAsrModel(appCfg.localAsrModel);
        }
        setDefaultTranscriptionLanguage(appCfg.defaultTranscriptionLanguage || "");
        setDefaultSummaryLanguage(appCfg.defaultSummaryLanguage || "");
        if (appCfg.transcriptionProvider === "speechmatics" || appCfg.transcriptionProvider === "local" || appCfg.transcriptionProvider === "assemblyai" || appCfg.transcriptionProvider === "muse" || appCfg.transcriptionProvider === "modal") {
          setTranscriptionProvider(appCfg.transcriptionProvider);
        }
        if (appCfg.alwaysRetranscribePlaud) {
          setPlaudRetranscribeMode("always");
        } else if (appCfg.retranscribePlaudWhenUnnamed) {
          setPlaudRetranscribeMode("unnamed");
        } else {
          setPlaudRetranscribeMode("off");
        }
        if (typeof appCfg.hfToken === "string") {
          setHfToken(appCfg.hfToken);
        }
        if (typeof appCfg.speechmaticsApiKey === "string") {
          setSpeechmaticsApiKey(appCfg.speechmaticsApiKey);
        }
        if (typeof appCfg.assemblyaiApiKey === "string") {
          setAssemblyaiApiKey(appCfg.assemblyaiApiKey);
        }
        if (typeof appCfg.museApiKey === "string") {
          setMuseApiKey(appCfg.museApiKey);
        }
        if (typeof appCfg.modalTokenId === "string") setModalTokenId(appCfg.modalTokenId);
        if (typeof appCfg.modalTokenSecret === "string") setModalTokenSecret(appCfg.modalTokenSecret);
        if (typeof appCfg.modalAppName === "string" && appCfg.modalAppName) setModalAppName(appCfg.modalAppName);
        if (appCfg.modalAsrModel) setSettingsModalAsrModel(appCfg.modalAsrModel);
      }

      if (provRes.ok) {
        const pData = await provRes.json();
        setProviders(pData.providers || []);
      }

      if (modelsRes.ok) {
        const mData = await modelsRes.json();
        setModels(mData.models || []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchData();
  }, []);

  const handleProviderChange = (pId: string) => {
    setSelectedProvider(pId);
    setApiKey("");
    setBaseUrl(savedProviders[pId]?.baseUrl || "");
    setTestResult(null);
    const providerModels = models.filter((m) => m.provider === pId);
    if (providerModels.length > 0) {
      setSelectedModel(providerModels[0].id);
      const supported = providerModels[0].supportedThinkingLevels || ["low", "medium", "high"];
      setThinkingLevel(supported.includes("off") ? "off" : supported[0] || "low");
    }
  };

  const handleModelChange = (mId: string) => {
    setSelectedModel(mId);
    setTestResult(null);
    const m = models.find((mod) => mod.provider === selectedProvider && mod.id === mId);
    if (m?.supportedThinkingLevels) {
      if (!m.supportedThinkingLevels.includes(thinkingLevel as any)) {
        setThinkingLevel(m.supportedThinkingLevels[0] || "low");
      }
    }
  };

  const handleRefreshCatalog = async () => {
    setRefreshingCatalog(true);
    try {
      const res = await fetch("/api/llm/refresh-catalog", { method: "POST" });
      if (res.ok) {
        const mRes = await fetch("/api/llm/models");
        if (mRes.ok) {
          const mData = await mRes.json();
          setModels(mData.models || []);
        }
      }
    } catch (err) {
      notify("error", "Failed to refresh catalog: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setRefreshingCatalog(false);
    }
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/llm/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: selectedProvider,
          model: selectedModel,
          apiKey: apiKey.trim() || undefined,
          baseUrl: baseUrl.trim() || undefined,
          thinkingLevel: selectedModelObj?.reasoning ? thinkingLevel : undefined
        })
      });

      const data = await res.json();
      if (res.ok && data.ok) {
        setTestResult({
          ok: true,
          message: `Connected successfully! Response: "${data.response}"`,
          durationMs: data.durationMs
        });
      } else {
        setTestResult({
          ok: false,
          message: data.error || "Connection failed"
        });
      }
    } catch (err) {
      setTestResult({
        ok: false,
        message: err instanceof Error ? err.message : String(err)
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const payload: Record<string, any> = {
        defaultProvider: selectedProvider,
        defaultModel: selectedModel,
        defaultThinkingLevel: selectedModelObj?.reasoning ? thinkingLevel : "off",
        providers: {
          [selectedProvider]: {
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
            baseUrl: baseUrl.trim()
          }
        }
      };

      const [resLlm, resApp] = await Promise.all([
        fetch("/api/llm/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        }),
        fetch("/api/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            localClusteringThreshold,
            localSimilarityThreshold,
            localAsrModel,
            transcriptionProvider,
            defaultTranscriptionLanguage,
            defaultSummaryLanguage,
            retranscribePlaudWhenUnnamed: plaudRetranscribeMode === "unnamed",
            alwaysRetranscribePlaud: plaudRetranscribeMode === "always",
            hfToken,
            speechmaticsApiKey,
            assemblyaiApiKey,
            museApiKey,
            modalTokenId,
            modalTokenSecret,
            modalAppName,
            modalAsrModel: settingsModalAsrModel
          })
        })
      ]);

      if (!resLlm.ok) {
        const data = await resLlm.json();
        throw new Error(data.error || "Failed to save LLM configuration");
      }

      if (!resApp.ok) {
        const data = await resApp.json();
        throw new Error(data.error || "Failed to save audio settings");
      }

      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  const providerModels = models.filter((m) => m.provider === selectedProvider);

  const selectedModelObj = models.find((m) => m.provider === selectedProvider && m.id === selectedModel);
  const currentProviderSummary = providers.find((p) => p.id === selectedProvider);

  return (
    <Modal onClose={onClose} title={"LLM Provider & Model Settings"} ariaLabel="LLM provider and model settings" maxWidth="max-w-2xl">
      <p className="text-xs text-base-content/70">Powered by pi-ai unified multi-provider model catalog</p>
      {error && (
        <div className="alert alert-soft alert-error p-3 text-xs text-error">
          {error}
        </div>
      )}

      {loading ? (
        <div className="p-8 text-center text-sm text-base-content/70">Loading catalog…</div>
      ) : (
        <form onSubmit={handleSave} className="space-y-4">
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
                options={llmProviderOptions(providers)}
              />
              <div className="flex items-center justify-between pt-1">
                <span className="text-[11px] text-base-content/50">
                  Status: {currentProviderSummary?.isConfigured ? "🟢 Key Configured" : "🟡 Needs API Key"}
                </span>
                <button
                  type="button"
                  onClick={() => void handleRefreshCatalog()}
                  disabled={refreshingCatalog}
                  className="text-[11px] text-primary hover:underline disabled:opacity-50"
                >
                  {refreshingCatalog ? "Syncing…" : "↻ Sync Web Catalog"}
                </button>
              </div>
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
            <label className="text-xs font-medium uppercase tracking-wider text-base-content/70">
              API Key Override (Optional)
            </label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={currentProviderSummary?.isConfigured ? "Using configured environment key (leave blank to keep)" : "Enter provider API key…"}
              className="input input-md w-full placeholder-base-content/50 font-mono"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium uppercase tracking-wider text-base-content/70">
              Base URL Override (Optional)
            </label>
            <input
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="e.g. http://localhost:11434/v1 for Ollama, or custom LiteLLM proxy"
              className="input input-md w-full placeholder-base-content/50 font-mono"
            />
          </div>

          <div className="rounded-xl border border-base-300 bg-base-100/60 p-4 space-y-3">
            <span className="block text-xs font-semibold uppercase tracking-wider text-base-content">Default Language</span>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="block text-xs text-base-content font-medium">Transcriptions</label>
                <Combobox
                  value={defaultTranscriptionLanguage}
                  onChange={setDefaultTranscriptionLanguage}
                  placeholder="Select language…"
                  ariaLabel="Default transcription language"
                  searchPlaceholder="Search languages…"
                  options={languageOptions("Engine default (English on local / Speechmatics)", TRANSCRIPTION_AUTO_LABEL)}
                />
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs text-base-content font-medium">Summaries</label>
                <Combobox
                  value={defaultSummaryLanguage}
                  onChange={setDefaultSummaryLanguage}
                  placeholder="Select language…"
                  ariaLabel="Default summary language"
                  searchPlaceholder="Search languages…"
                  options={languageOptions("Template default", SUMMARY_AUTO_LABEL)}
                />
              </div>
            </div>
            <p className="text-[11px] text-base-content/50">
              Used for uploads, Plaud syncs and auto-summaries. Each transcription or summary can still pick another language. Templates can reference it with {"{{language}}"}.
            </p>
          </div>

          {/* Local Audio Diarization & Speaker Recognition Settings */}
          <div className="rounded-xl border border-base-300 bg-base-100/60 p-4 space-y-3.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-base-content">
                <Mic className="h-4 w-4 shrink-0" aria-hidden="true" /> Local ASR & Speaker Recognition
              </span>
              <span className="text-[11px] text-base-content/50 font-mono">Engine & Sensitivity Tuning</span>
            </div>

            {/* Hugging Face Token for Gated Diarization Models */}
            <div className="space-y-1.5">
              <label
                htmlFor="hf-token-input"
                className="text-xs text-base-content font-medium flex items-center justify-between"
              >
                <span>Hugging Face Access Token (pyannote community-1):</span>
                <span className="text-[10px] text-base-content/50 font-mono">HF_TOKEN env overrides</span>
              </label>
              <input
                id="hf-token-input"
                type="password"
                value={hfToken}
                onChange={(e) => setHfToken(e.target.value)}
                placeholder="hf_..."
                className="input input-md w-full placeholder-base-content/50 font-mono"
              />
              <p className="text-[11px] text-base-content/50 leading-tight">
                Used to download gated pyannote diarization models. Accept terms on huggingface.co/pyannote/speaker-diarization-community-1.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 pt-1">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <label htmlFor="clustering-threshold-slider" className="text-base-content font-medium">
                    Within-Meeting Clustering:
                  </label>
                  <span className="font-mono font-bold text-primary">
                    {localClusteringThreshold.toFixed(2)}
                  </span>
                </div>
                <input
                  id="clustering-threshold-slider"
                  type="range"
                  min="0.10"
                  max="0.95"
                  step="0.01"
                  value={localClusteringThreshold}
                  onChange={(e) => setLocalClusteringThreshold(parseFloat(e.target.value))}
                  className="range range-sm w-full"
                />
                <p className="text-[11px] text-base-content/50 leading-tight">
                  Controls separation of distinct voices within a meeting (recommended: 0.50).
                </p>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <label htmlFor="similarity-threshold-slider" className="text-base-content font-medium">
                    Enrolled Voiceprint Matching:
                  </label>
                  <span className="font-mono font-bold text-accent">
                    {localSimilarityThreshold.toFixed(2)}
                  </span>
                </div>
                <input
                  id="similarity-threshold-slider"
                  type="range"
                  min="0.10"
                  max="0.95"
                  step="0.01"
                  value={localSimilarityThreshold}
                  onChange={(e) => setLocalSimilarityThreshold(parseFloat(e.target.value))}
                  className="range range-sm w-full"
                />
                <p className="text-[11px] text-base-content/50 leading-tight">
                  Minimum cosine similarity required to match speech against enrolled WeSpeaker voiceprints (recommended: 0.45).
                </p>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-base-300 bg-base-100/60 p-4 space-y-2">
            <label className="block text-xs font-semibold uppercase tracking-wider text-base-content">
              Automatic Transcription Engine
            </label>
            <Combobox
              value={transcriptionProvider}
              onChange={(v) => setTranscriptionProvider(v as "speechmatics" | "local" | "assemblyai" | "muse" | "modal")}
              placeholder="Select engine…"
              ariaLabel="Automatic transcription engine"
              searchPlaceholder="Search engines…"
              options={TRANSCRIBE_PROVIDER_OPTIONS}
            />
            <p className="text-[11px] text-base-content/50">
              Controls the default for new uploads and manual transcription. Keys entered below take effect immediately; environment variables (ASSEMBLY_API_KEY, SPEECHMATICS_API_KEY, MUSE_API_KEY, MODAL_TOKEN_ID/MODAL_TOKEN_SECRET) override them when set.
            </p>
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold uppercase tracking-wider text-base-content">
                Plaud recordings
              </label>
              <Combobox
                value={plaudRetranscribeMode}
                onChange={(v) => setPlaudRetranscribeMode(v as "off" | "unnamed" | "always")}
                placeholder="Select Plaud transcript policy…"
                ariaLabel="Plaud transcript policy"
                searchPlaceholder="Search Plaud options…"
                options={PLAUD_RETRANSCRIBE_OPTIONS}
              />
              <p className="text-[11px] text-base-content/50">
                Plaud&apos;s transcript is always kept as a fallback. Re-transcribing uses the engine above as authoritative; changes take effect immediately without a restart.
              </p>
            </div>
            <div className="space-y-1.5 pt-1">
              <label htmlFor="speechmatics-key-input" className="text-xs text-base-content font-medium flex items-center justify-between">
                <span>Speechmatics API Key:</span>
                <span className="text-[10px] text-base-content/50 font-mono">SPEECHMATICS_API_KEY env overrides</span>
              </label>
              <input
                id="speechmatics-key-input"
                type="password"
                value={speechmaticsApiKey}
                onChange={(e) => setSpeechmaticsApiKey(e.target.value)}
                placeholder="Speechmatics key…"
                autoComplete="off"
                className="input input-md w-full placeholder-base-content/50 font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="assemblyai-key-input" className="text-xs text-base-content font-medium flex items-center justify-between">
                <span>AssemblyAI API Key:</span>
                <span className="text-[10px] text-base-content/50 font-mono">ASSEMBLY_API_KEY env overrides</span>
              </label>
              <input
                id="assemblyai-key-input"
                type="password"
                value={assemblyaiApiKey}
                onChange={(e) => setAssemblyaiApiKey(e.target.value)}
                placeholder="AssemblyAI key…"
                autoComplete="off"
                className="input input-md w-full placeholder-base-content/50 font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="muse-key-input" className="text-xs text-base-content font-medium flex items-center justify-between">
                <span>Muse Voice API Key:</span>
                <span className="text-[10px] text-base-content/50 font-mono">MUSE_API_KEY env overrides</span>
              </label>
              <input
                id="muse-key-input"
                type="password"
                value={museApiKey}
                onChange={(e) => setMuseApiKey(e.target.value)}
                placeholder="Muse Voice key…"
                autoComplete="off"
                className="input input-md w-full placeholder-base-content/50 font-mono"
              />
            </div>
            <div className="space-y-1.5 rounded-lg border border-base-300 p-3">
              <div className="text-xs text-base-content font-medium flex items-center justify-between">
                <span>Modal GPU worker</span>
                <span className="text-[10px] text-base-content/50 font-mono">MODAL_TOKEN_ID / MODAL_TOKEN_SECRET env override</span>
              </div>
              <input
                id="modal-token-id-input"
                aria-label="Modal token ID"
                type="text"
                value={modalTokenId}
                onChange={(e) => setModalTokenId(e.target.value)}
                placeholder="Token ID (ak-…)"
                autoComplete="off"
                className="input input-md w-full placeholder-base-content/50 font-mono"
              />
              <input
                id="modal-token-secret-input"
                aria-label="Modal token secret"
                type="password"
                value={modalTokenSecret}
                onChange={(e) => setModalTokenSecret(e.target.value)}
                placeholder="Token secret (as-…)"
                autoComplete="off"
                className="input input-md w-full placeholder-base-content/50 font-mono"
              />
              <input
                id="modal-app-name-input"
                aria-label="Modal app name"
                type="text"
                value={modalAppName}
                onChange={(e) => setModalAppName(e.target.value)}
                placeholder="Deployed app name (olive-gpu)"
                autoComplete="off"
                className="input input-md w-full placeholder-base-content/50 font-mono"
              />
              <Combobox
                value={settingsModalAsrModel}
                onChange={(v) => setSettingsModalAsrModel(v as ModalAsrModel)}
                placeholder="Select STT model…"
                ariaLabel="Default Modal speech-to-text model"
                searchPlaceholder="Search models…"
                options={MODAL_ASR_MODEL_OPTIONS}
              />
              <p className="text-[11px] text-base-content/50">
                Default speech-to-text model for the Modal engine; it can be overridden per meeting. Deploy the worker with <span className="font-mono">modal deploy modal_app/olive_gpu.py</span>.
              </p>
            </div>
          </div>

          {testResult && (
            <div
              className={`rounded-lg border p-3 text-xs ${
                testResult.ok
                  ? "border-primary/30 bg-primary/10 text-primary"
                  : "border-error/30 bg-error/10 text-error"
              }`}
            >
              <div className="flex items-center justify-between">
                <span>{testResult.message}</span>
                {testResult.durationMs && (
                  <span className="font-mono text-[10px] opacity-75">{testResult.durationMs}ms</span>
                )}
              </div>
            </div>
          )}

          <div className="flex items-center justify-between border-t border-base-300 pt-4">
            <button
              type="button"
              onClick={() => void handleTestConnection()}
              disabled={testing}
              className="btn btn-sm bg-base-300 min-h-11"
            >
              {testing ? "Testing…" : <><Zap className="h-4 w-4 shrink-0" aria-hidden="true" /> Test Connection</>}
            </button>

            <div className="flex gap-3">
              <button
                type="button"
                onClick={onClose}
                disabled={saving}
                className="btn btn-sm min-h-11"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="btn btn-primary btn-sm inline-flex items-center gap-2 min-h-11"
              >
                {saving ? "Saving…" : "Save LLM Settings"}
              </button>
            </div>
          </div>
        </form>
      )}
    </Modal>
  );
}
