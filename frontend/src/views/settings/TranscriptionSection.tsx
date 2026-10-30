import type { ReactElement, ReactNode } from "react";
import { BookA, Cloud, Cpu, Zap } from "lucide-react";
import { Combobox } from "../../components/Combobox";
import { MODAL_ASR_MODEL_OPTIONS, PLAUD_RETRANSCRIBE_OPTIONS, type ModalAsrModel } from "../../components/OptionComboboxes";
import { GroupTitle, INPUT_CLASS, Panel, SecretField, SectionHeader, SettingsRow, SettingsRows, type AppConfigDto } from "./shared";

type Engine = AppConfigDto["transcriptionProvider"];
type PlaudPolicy = "off" | "unnamed" | "always";

export function plaudPolicyOf(cfg: Pick<AppConfigDto, "alwaysRetranscribePlaud" | "retranscribePlaudWhenUnnamed">): PlaudPolicy {
  if (cfg.alwaysRetranscribePlaud) return "always";
  if (cfg.retranscribePlaudWhenUnnamed) return "unnamed";
  return "off";
}

interface EngineInfo {
  value: Engine;
  name: string;
  desc: string;
  icon: ReactNode;
  ready: (cfg: AppConfigDto) => { ok: boolean; text: string };
}

const ICON = "h-4 w-4 shrink-0 text-base-content/60";

const ENGINES: EngineInfo[] = [
  {
    value: "local",
    name: "Local pipeline",
    desc: "Runs on this server. Private, with speaker recognition; slower on long recordings.",
    icon: <Cpu className={ICON} aria-hidden="true" />,
    ready: (cfg) =>
      cfg.hasHfToken
        ? { ok: true, text: "Ready · Hugging Face token set" }
        : { ok: false, text: "Needs a Hugging Face token (Speaker recognition)" },
  },
  {
    value: "modal",
    name: "Modal GPU",
    desc: "The local pipeline on a Modal.com GPU worker. Much faster on long recordings.",
    icon: <Zap className={ICON} aria-hidden="true" />,
    ready: (cfg) => (cfg.hasModalToken ? { ok: true, text: "Token configured" } : { ok: false, text: "Needs a Modal token" }),
  },
  {
    value: "assemblyai",
    name: "AssemblyAI",
    desc: "Cloud. Fast, with good speaker labels.",
    icon: <Cloud className={ICON} aria-hidden="true" />,
    ready: (cfg) => (cfg.hasAssemblyaiApiKey ? { ok: true, text: "API key configured" } : { ok: false, text: "Needs an API key" }),
  },
  {
    value: "speechmatics",
    name: "Speechmatics",
    desc: "Cloud. Remembers voices across meetings.",
    icon: <Cloud className={ICON} aria-hidden="true" />,
    ready: (cfg) => (cfg.hasSpeechmaticsApiKey ? { ok: true, text: "API key configured" } : { ok: false, text: "Needs an API key" }),
  },
  {
    value: "muse",
    name: "Muse Voice",
    desc: "Cloud. Low cost, no speaker memory.",
    icon: <Cloud className={ICON} aria-hidden="true" />,
    ready: (cfg) => (cfg.hasMuseApiKey ? { ok: true, text: "API key configured" } : { ok: false, text: "Needs an API key" }),
  },
];

/** Whether an engine can be biased with the custom vocabulary (Cohere has no prompt hook). */
export function supportsCustomVocabulary(engine: Engine, modalAsrModel: AppConfigDto["modalAsrModel"]): boolean {
  if (engine === "local") return false;
  if (engine === "modal") return modalAsrModel !== "cohere";
  return true;
}

function CustomVocabulary({
  draft,
  onChange,
}: {
  draft: AppConfigDto;
  onChange: <K extends keyof AppConfigDto>(key: K, value: AppConfigDto[K]) => void;
}): ReactElement {
  const terms = draft.customVocabulary ?? [];
  const count = terms.filter((t) => t.trim()).length;
  const supported = supportsCustomVocabulary(draft.transcriptionProvider, draft.modalAsrModel);
  const engineName = ENGINES.find((e) => e.value === draft.transcriptionProvider)?.name ?? draft.transcriptionProvider;

  return (
    <>
      <GroupTitle>Custom vocabulary</GroupTitle>
      <Panel>
        <p className="text-[13px] text-base-content/65">
          Names, acronyms and jargon to spell correctly, one per line. Used by Speechmatics, AssemblyAI, Muse Voice and Modal GPU with a Whisper
          model. <strong className="font-semibold text-base-content/80">Not supported</strong> by the Local pipeline or Modal GPU with Cohere. Summaries
          also receive the list as a spelling glossary.
        </p>
        {!supported && (
          <p role="status" className="flex items-center gap-2 text-[13px] text-[color:var(--tag-orange)]">
            <BookA className="h-4 w-4 shrink-0" aria-hidden="true" />
            {draft.transcriptionProvider === "modal" ? "Modal GPU with Cohere" : engineName} ignores this vocabulary; only summaries will use it.
          </p>
        )}
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className="sr-only">Custom vocabulary, one term per line</span>
          <textarea
            value={terms.join("\n")}
            onChange={(e) => onChange("customVocabulary", e.target.value.split("\n"))}
            rows={6}
            placeholder={"Olive\nPlaud NotePin\nKubernetes"}
            spellCheck={false}
            className="textarea min-h-[8rem] w-full rounded-md border-base-content/15 bg-base-100 font-mono text-sm shadow-none focus:border-primary/60 focus:outline-2 focus:outline-offset-0 focus:outline-primary/20"
          />
          <span className="text-xs text-base-content/60">
            {count} {count === 1 ? "term" : "terms"} · up to 1000
          </span>
        </label>
      </Panel>
    </>
  );
}

export function TranscriptionSection({
  draft,
  saved,
  onChange,
  onOpenSpeakers,
}: {
  draft: AppConfigDto;
  saved: AppConfigDto;
  onChange: <K extends keyof AppConfigDto>(key: K, value: AppConfigDto[K]) => void;
  onOpenSpeakers: () => void;
}): ReactElement {
  const policy = plaudPolicyOf(draft);

  return (
    <section aria-labelledby="settings-transcription">
      <SectionHeader
        id="settings-transcription"
        title="Transcription"
        description="The engine used for uploads, Plaud recordings and bulk jobs, unless you pick another one."
      />

      <fieldset>
        <legend className="mb-2 text-[15px] font-semibold">Default engine</legend>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {ENGINES.map((e) => {
            const on = draft.transcriptionProvider === e.value;
            const status = e.ready(saved);
            return (
              <label
                key={e.value}
                className={`flex cursor-pointer gap-3 rounded-[10px] border p-3.5 transition-colors ${
                  on ? "border-primary bg-primary/8" : "border-base-content/12 hover:bg-hover"
                }`}
              >
                <input
                  type="radio"
                  name="transcription-engine"
                  value={e.value}
                  checked={on}
                  onChange={() => onChange("transcriptionProvider", e.value)}
                  className="radio radio-sm radio-primary mt-0.5"
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex items-center gap-2 font-semibold">
                    {e.icon}
                    {e.name}
                  </span>
                  <span className="text-[13px] text-base-content/65">{e.desc}</span>
                  <span className={`mt-1 text-xs ${status.ok ? "text-[color:var(--tag-green)]" : "text-[color:var(--tag-orange)]"}`}>{status.text}</span>
                </span>
              </label>
            );
          })}
        </div>
        {draft.transcriptionProvider === "local" && !saved.hasHfToken && (
          <p className="mt-2 text-[13px] text-base-content/65">
            Add the token in{" "}
            <button type="button" onClick={onOpenSpeakers} className="text-primary underline underline-offset-2">
              Speaker recognition
            </button>
            .
          </p>
        )}
      </fieldset>

      <div className="mt-6">
        <SettingsRows>
          <SettingsRow label="Plaud recordings" hint="Plaud's own transcript is always kept as a fallback. Re-transcribing uses the default engine.">
            <Combobox
              value={policy}
              onChange={(v) => {
                onChange("retranscribePlaudWhenUnnamed", v === "unnamed");
                onChange("alwaysRetranscribePlaud", v === "always");
              }}
              ariaLabel="Plaud transcript policy"
              placeholder="Select policy…"
              searchPlaceholder="Search options…"
              options={PLAUD_RETRANSCRIBE_OPTIONS}
            />
          </SettingsRow>
        </SettingsRows>
      </div>

      <CustomVocabulary draft={draft} onChange={onChange} />

      <GroupTitle>Cloud API keys</GroupTitle>
      <p className="mb-1 text-[13px] text-base-content/65">
        Keys saved here take effect right away. Environment variables, when set, take precedence.
      </p>
      <SettingsRows>
        <SettingsRow label="AssemblyAI" htmlFor="assemblyai-key">
          <SecretField
            id="assemblyai-key"
            label="AssemblyAI API key"
            value={draft.assemblyaiApiKey}
            savedValue={saved.assemblyaiApiKey}
            onChange={(v) => onChange("assemblyaiApiKey", v)}
            envName="ASSEMBLY_API_KEY"
            effective={saved.hasAssemblyaiApiKey}
          />
        </SettingsRow>
        <SettingsRow label="Speechmatics" htmlFor="speechmatics-key">
          <SecretField
            id="speechmatics-key"
            label="Speechmatics API key"
            value={draft.speechmaticsApiKey}
            savedValue={saved.speechmaticsApiKey}
            onChange={(v) => onChange("speechmaticsApiKey", v)}
            envName="SPEECHMATICS_API_KEY"
            effective={saved.hasSpeechmaticsApiKey}
          />
        </SettingsRow>
        <SettingsRow label="Muse Voice" htmlFor="muse-key">
          <SecretField
            id="muse-key"
            label="Muse Voice API key"
            value={draft.museApiKey}
            savedValue={saved.museApiKey}
            onChange={(v) => onChange("museApiKey", v)}
            envName="MUSE_API_KEY"
            effective={saved.hasMuseApiKey}
          />
        </SettingsRow>
      </SettingsRows>

      <GroupTitle>Modal GPU worker</GroupTitle>
      <Panel>
        <p className="text-[13px] text-base-content/65">
          Deploy the worker with <code className="font-mono">modal deploy modal_app/olive_gpu.py</code>. MODAL_TOKEN_ID and MODAL_TOKEN_SECRET in the
          environment take precedence.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className="text-[13px] font-medium text-base-content/70">Token ID</span>
            <input
              type="text"
              value={draft.modalTokenId}
              onChange={(e) => onChange("modalTokenId", e.target.value)}
              placeholder="ak-…"
              autoComplete="off"
              spellCheck={false}
              className={`${INPUT_CLASS} font-mono`}
            />
          </label>
          <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor="modal-token-secret" className="text-[13px] font-medium text-base-content/70">
              Token secret
            </label>
            <SecretField
              id="modal-token-secret"
              label="Modal token secret"
              value={draft.modalTokenSecret}
              savedValue={saved.modalTokenSecret}
              onChange={(v) => onChange("modalTokenSecret", v)}
              placeholder="as-…"
            />
          </div>
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className="text-[13px] font-medium text-base-content/70">App name</span>
            <input
              type="text"
              value={draft.modalAppName}
              onChange={(e) => onChange("modalAppName", e.target.value)}
              placeholder="olive-gpu"
              autoComplete="off"
              spellCheck={false}
              className={`${INPUT_CLASS} font-mono`}
            />
          </label>
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-[13px] font-medium text-base-content/70">Speech-to-text model</span>
            <Combobox
              value={draft.modalAsrModel}
              onChange={(v) => onChange("modalAsrModel", v as ModalAsrModel)}
              ariaLabel="Default Modal speech-to-text model"
              placeholder="Select model…"
              searchPlaceholder="Search models…"
              options={MODAL_ASR_MODEL_OPTIONS}
            />
            <span className="text-xs text-base-content/60">Default for the Modal engine; each meeting can pick another.</span>
          </div>
        </div>
      </Panel>

      <GroupTitle>Local pipeline</GroupTitle>
      <SettingsRows>
        <SettingsRow label="Speech model" hint="Model used by the local pipeline on this server.">
          <code className="block truncate font-mono text-[13px] text-base-content/70" title={draft.localAsrModel}>
            {draft.localAsrModel || "Default"}
          </code>
        </SettingsRow>
      </SettingsRows>
    </section>
  );
}
