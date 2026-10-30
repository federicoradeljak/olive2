import { useEffect, useId, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { Button, notify } from "../../components/ui";

/** Masked secret prefix returned by GET /api/config (mirrors backend settings.MASK_PREFIX). */
export const MASK_PREFIX = "••••••••";

export function isMaskedSecret(value: string | null | undefined): boolean {
  return !!value && value.startsWith(MASK_PREFIX);
}

/** AppConfig as served (masked) by GET /api/config; see backend olive/settings.py. */
export interface AppConfigDto {
  plaudAutoSync: boolean;
  pollIntervalMinutes: number;
  retranscribePlaudWhenUnnamed: boolean;
  alwaysRetranscribePlaud: boolean;
  transcriptionProvider: "speechmatics" | "assemblyai" | "muse" | "modal" | "local";
  localAsrModel: string;
  localClusteringThreshold: number;
  localSimilarityThreshold: number;
  defaultTranscriptionLanguage: string;
  defaultSummaryLanguage: string;
  customVocabulary: string[];
  hfToken: string;
  speechmaticsApiKey: string;
  assemblyaiApiKey: string;
  museApiKey: string;
  modalTokenId: string;
  modalTokenSecret: string;
  modalAppName: string;
  modalAsrModel: "cohere" | "whisper-large-v3-turbo" | "whisper-large-v3";
  hasHfToken?: boolean;
  hasSpeechmaticsApiKey?: boolean;
  hasAssemblyaiApiKey?: boolean;
  hasMuseApiKey?: boolean;
  hasModalToken?: boolean;
}

export type AppConfigKey = Exclude<keyof AppConfigDto, `has${string}`>;

export async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as { error?: unknown; detail?: unknown };
    if (typeof data.error === "string" && data.error) return data.error;
    if (typeof data.detail === "string" && data.detail) return data.detail;
  } catch {
    // non-JSON body
  }
  return `${fallback} (HTTP ${res.status})`;
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

export function SectionHeader({ id, title, description }: { id: string; title: string; description: ReactNode }): ReactElement {
  return (
    <header className="mb-5">
      <h2 id={id} className="text-2xl font-bold tracking-tight">
        {title}
      </h2>
      <p className="mt-1 text-sm text-base-content/65">{description}</p>
    </header>
  );
}

/** Group heading inside a section (plain weight, no uppercase eyebrow). */
export function GroupTitle({ children, action }: { children: ReactNode; action?: ReactNode }): ReactElement {
  return (
    <div className="mt-8 mb-2 flex flex-wrap items-center justify-between gap-2 first:mt-0">
      <h3 className="text-[15px] font-semibold">{children}</h3>
      {action}
    </div>
  );
}

/** Hairline list of label/hint + control rows (Notion settings look). */
export function SettingsRows({ children }: { children: ReactNode }): ReactElement {
  return <div className="flex flex-col border-t border-divider">{children}</div>;
}

export function SettingsRow({
  label,
  hint,
  htmlFor,
  children,
  error,
  stack = false,
}: {
  label: ReactNode;
  hint?: ReactNode;
  htmlFor?: string;
  children?: ReactNode;
  error?: ReactNode;
  /** Put the control under the label at every width (for wide controls). */
  stack?: boolean;
}): ReactElement {
  return (
    <div className={`flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-divider py-4 ${stack ? "flex-col items-stretch" : ""}`}>
      <div className="flex min-w-0 flex-[1_1_16rem] flex-col">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="font-medium">
            {label}
          </label>
        ) : (
          <span className="font-medium">{label}</span>
        )}
        {hint && <span className="text-[13px] text-base-content/65">{hint}</span>}
        {error && (
          <span role="alert" className="mt-1 text-[13px] text-error">
            {error}
          </span>
        )}
      </div>
      {children !== undefined && <div className={`min-w-0 ${stack ? "w-full" : "w-full sm:w-auto sm:max-w-[22rem] sm:flex-[0_1_18rem]"}`}>{children}</div>}
    </div>
  );
}

/** Bordered card used for integrations and grouped forms. */
export function Panel({ children, className = "" }: { children: ReactNode; className?: string }): ReactElement {
  return <div className={`flex flex-col gap-3 rounded-xl border border-base-content/12 p-4 sm:p-5 ${className}`}>{children}</div>;
}

export type TagTone = "gray" | "green" | "yellow" | "orange" | "red" | "blue";

export function StatusTag({ tone, children }: { tone: TagTone; children: ReactNode }): ReactElement {
  return <span className={`tag text-xs ${tone === "gray" ? "" : `tag-${tone}`}`}>{children}</span>;
}

/* ------------------------------------------------------------------ */
/* Controls                                                            */
/* ------------------------------------------------------------------ */

export const INPUT_CLASS =
  "input h-9 w-full rounded-md border-base-content/15 bg-base-100 text-sm shadow-none focus-within:border-primary/60 focus-within:outline-2 focus-within:outline-offset-0 focus-within:outline-primary/20 max-sm:h-11";

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  ariaLabel: string;
}): ReactElement {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="inline-flex w-full rounded-lg bg-hover p-[3px] sm:w-auto">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={`h-[30px] flex-1 rounded-md px-3.5 text-[13px] max-sm:h-10 sm:flex-none ${
              on ? "bg-base-100 font-semibold shadow-[0_1px_2px_rgba(0,0,0,0.12)]" : "text-base-content/70 hover:text-base-content"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Secret input for API keys and tokens. Shows the masked saved value with a
 * Replace action; typing a new value replaces it on save, Remove clears the
 * stored value (an environment variable still applies when set).
 */
export function SecretField({
  id,
  label,
  value,
  savedValue,
  onChange,
  placeholder,
  envName,
  effective,
}: {
  id: string;
  label: string;
  value: string;
  savedValue: string;
  onChange: (value: string) => void;
  placeholder?: string;
  envName?: string;
  /** True when a key is in effect (stored or from the environment). */
  effective?: boolean;
}): ReactElement {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const changed = value !== savedValue;
  const showInput = editing || changed || !savedValue;

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    if (!changed) setEditing(false);
  }, [changed]);

  const status = savedValue
    ? null
    : effective && envName
      ? `Using ${envName} from the environment`
      : null;

  if (!showInput) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-base-content/65" aria-label={`${label}: saved`}>
          {savedValue.replace(MASK_PREFIX, "••••")}
        </span>
        <Button size="sm" variant="secondary" onClick={() => setEditing(true)} aria-label={`Replace ${label}`}>
          Replace
        </Button>
        <Button size="sm" variant="dangerSoft" onClick={() => onChange("")} aria-label={`Remove ${label}`}>
          Remove
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          id={id}
          type="password"
          value={isMaskedSecret(value) ? "" : value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? (effective && envName ? `Using ${envName}` : "Paste key")}
          autoComplete="off"
          spellCheck={false}
          aria-label={label}
          className={`${INPUT_CLASS} font-mono`}
        />
        {savedValue && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              onChange(savedValue);
              setEditing(false);
            }}
          >
            Cancel
          </Button>
        )}
      </div>
      {status && <span className="text-xs text-base-content/60">{status}</span>}
      {savedValue && value === "" && <span className="text-xs text-warning">The saved key will be removed when you save.</span>}
    </div>
  );
}

export function useCopy(): (text: string, what?: string) => void {
  return (text, what = "Link") => {
    const done = () => notify("success", `${what} copied`);
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done, () => notify("error", "Could not copy to the clipboard"));
      return;
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      done();
    } catch {
      notify("error", "Could not copy to the clipboard");
    } finally {
      ta.remove();
    }
  };
}

/** Read-only monospace value with a Copy button. */
export function CopyField({ value, label }: { value: string; label: string }): ReactElement {
  const copy = useCopy();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-h-9 items-center gap-2 rounded-md bg-hover pl-2.5 pr-1">
      <code className="min-w-0 flex-1 truncate py-1.5 font-mono text-[13px]" title={value}>
        {value}
      </code>
      <button
        type="button"
        aria-label={`Copy ${label}`}
        onClick={() => {
          copy(value, label);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        }}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded px-2 text-xs hover:bg-hover max-sm:h-11"
      >
        {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
        Copy
      </button>
    </div>
  );
}

/** Threshold slider with plain-language end labels and a reset to the recommended value. */
export function ThresholdSlider({
  label,
  value,
  onChange,
  recommended,
  min = 0.1,
  max = 0.95,
  left = "Looser",
  right = "Stricter",
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  recommended: number;
  min?: number;
  max?: number;
  left?: string;
  right?: string;
}): ReactElement {
  const id = useId();
  return (
    <div className="flex w-full flex-col gap-1">
      <div className="flex items-center gap-3">
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={0.01}
          value={value}
          onChange={(e) => onChange(Number.parseFloat(e.target.value))}
          aria-label={label}
          aria-valuetext={`${value.toFixed(2)} (${value < recommended ? left.toLowerCase() : value > recommended ? right.toLowerCase() : "recommended"})`}
          className="range range-xs range-primary flex-1 max-sm:my-3"
        />
        <span className="w-9 text-right font-mono text-xs tabular-nums text-base-content/70">{value.toFixed(2)}</span>
      </div>
      <div className="flex justify-between pr-12 text-xs text-base-content/60">
        <span>{left}</span>
        <span>{right}</span>
      </div>
      {Math.abs(value - recommended) > 0.001 && (
        <button type="button" onClick={() => onChange(recommended)} className="self-start text-xs text-primary hover:underline max-sm:min-h-11">
          Reset to recommended ({recommended.toFixed(2)})
        </button>
      )}
    </div>
  );
}

/** Sticky bar that appears while a section has unsaved changes. */
export function SaveBar({
  dirty,
  saving,
  onSave,
  onDiscard,
  disabled,
  message,
}: {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  disabled?: boolean;
  message?: ReactNode;
}): ReactElement | null {
  if (!dirty && !saving) return null;
  return (
    <div className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-20 mt-6 lg:bottom-5">
      <div role="region" aria-label="Unsaved changes" className="flex flex-wrap items-center gap-3 rounded-xl bg-base-100 px-4 py-3 shadow-pop">
        <span className="min-w-0 flex-1 text-sm text-base-content/75">{message ?? "You have unsaved changes."}</span>
        <Button variant="ghost" size="sm" onClick={onDiscard} disabled={saving}>
          Discard
        </Button>
        <Button variant="primary" size="sm" onClick={onSave} disabled={saving || disabled}>
          {saving && <span className="loading loading-spinner loading-xs" aria-hidden="true" />}
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </div>
  );
}
