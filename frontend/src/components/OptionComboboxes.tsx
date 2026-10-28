import type { ReactElement } from "react";
import {
  BadgeCheck,
  Brain,
  Bug,
  CircleCheck,
  CircleX,
  Cloud,
  Cpu,
  Info,
  Star,
  Tag,
  Zap,
  TriangleAlert,
} from "lucide-react";
import { Combobox } from "./Combobox";
import type { ComboboxOption } from "./Combobox";

/** Transcription provider values used by bulk / settings forms: "local" | "speechmatics" | "assemblyai" | "muse" | "modal". */
export const TRANSCRIBE_PROVIDER_OPTIONS: ComboboxOption[] = [
  {
    value: "assemblyai",
    label: "AssemblyAI (Cloud)",
    keywords: "cloud",
    icon: <Cloud className="h-3.5 w-3.5 shrink-0 text-info" aria-hidden="true" />,
  },
  {
    value: "muse",
    label: "Muse Voice (Cloud)",
    keywords: "cloud meta",
    icon: <Cloud className="h-3.5 w-3.5 shrink-0 text-info" aria-hidden="true" />,
  },
  {
    value: "speechmatics",
    label: "Speechmatics (Cloud)",
    keywords: "cloud",
    icon: <Cloud className="h-3.5 w-3.5 shrink-0 text-info" aria-hidden="true" />,
  },
  {
    value: "modal",
    label: "Modal GPU (Local pipeline in the cloud)",
    keywords: "cloud gpu modal whisper cohere",
    icon: <Zap className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />,
  },
  {
    value: "local",
    label: "Local (Cohere + Diarization)",
    keywords: "local on-device cohere",
    icon: <Cpu className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />,
  },
];

/** Plaud ingest transcript policy: keep Plaud's, re-transcribe when unnamed, or always re-transcribe. */
export const PLAUD_RETRANSCRIBE_OPTIONS: ComboboxOption[] = [
  {
    value: "off",
    label: "Use Plaud transcript",
    keywords: "plaud keep fallback",
  },
  {
    value: "unnamed",
    label: "Re-transcribe when speakers are unnamed",
    keywords: "plaud unnamed generic speakers",
  },
  {
    value: "always",
    label: "Always re-transcribe with the configured engine",
    keywords: "plaud always authoritative engine",
  },
];

/** Engine values used by the meeting detail + upload pickers ("local:cohere" scheme). */
export const ENGINE_OPTIONS: ComboboxOption[] = [
  {
    value: "local:cohere",
    label: "Local (Cohere + Diarization) (Default)",
    keywords: "local on-device default",
    icon: <Cpu className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />,
  },
  {
    value: "speechmatics",
    label: "Speechmatics (Cloud)",
    keywords: "cloud",
    icon: <Cloud className="h-3.5 w-3.5 shrink-0 text-info" aria-hidden="true" />,
  },
  {
    value: "assemblyai",
    label: "AssemblyAI (Cloud)",
    keywords: "cloud",
    icon: <Cloud className="h-3.5 w-3.5 shrink-0 text-info" aria-hidden="true" />,
  },
  {
    value: "muse",
    label: "Muse Voice (Cloud)",
    keywords: "cloud meta",
    icon: <Cloud className="h-3.5 w-3.5 shrink-0 text-info" aria-hidden="true" />,
  },
  {
    value: "modal",
    label: "Modal GPU (Local pipeline in the cloud)",
    keywords: "cloud gpu modal whisper cohere",
    icon: <Zap className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />,
  },
];

/** Speech-to-text models the Modal GPU worker can run. */
export const MODAL_ASR_MODEL_OPTIONS: ComboboxOption[] = [
  {
    value: "cohere",
    label: "Cohere Transcribe (same as local)",
    keywords: "cohere default",
  },
  {
    value: "whisper-large-v3-turbo",
    label: "Whisper large-v3-turbo (fast)",
    keywords: "whisper openai turbo fast",
  },
  {
    value: "whisper-large-v3",
    label: "Whisper large-v3 (most accurate, slower)",
    keywords: "whisper openai accurate",
  },
];

export type ModalAsrModel = "cohere" | "whisper-large-v3-turbo" | "whisper-large-v3";

export const TRANSCRIPT_PROVIDER_FILTER_OPTIONS: ComboboxOption[] = [
  { value: "any", label: "Any (no filter)" },
  { value: "local", label: "Local" },
  { value: "speechmatics", label: "Speechmatics" },
  { value: "assemblyai", label: "AssemblyAI" },
  { value: "muse", label: "Muse Voice" },
  { value: "modal", label: "Modal GPU" },
  { value: "plaud", label: "Plaud" },
  { value: "none", label: "No transcript yet" },
];

/** ISO 639-1 codes offered for transcription / summary language (mirrors backend olive/languages.py). */
const LANGUAGES: Array<[code: string, name: string]> = [
  ["es", "Spanish"],
  ["en", "English"],
  ["pt", "Portuguese"],
  ["fr", "French"],
  ["de", "German"],
  ["it", "Italian"],
  ["nl", "Dutch"],
  ["pl", "Polish"],
  ["ru", "Russian"],
  ["tr", "Turkish"],
  ["ar", "Arabic"],
  ["zh", "Chinese"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["vi", "Vietnamese"],
];

/** Language picker options; the empty value means "fall back to the default" (described by `defaultLabel`). */
export function languageOptions(defaultLabel: string): ComboboxOption[] {
  return [
    { value: "", label: defaultLabel, keywords: "default auto" },
    ...LANGUAGES.map(([code, name]) => ({ value: code, label: name, description: code, keywords: code })),
  ];
}

interface TemplateLike {
  id: string;
  name: string;
  isDefault: boolean;
  isBuiltin: boolean;
}

export function templateOptions(templates: TemplateLike[]): ComboboxOption[] {
  return templates.map((t) => ({
    value: t.id,
    label: t.name,
    description: t.isDefault ? "Default template" : t.isBuiltin ? "Built-in" : "Custom",
    keywords: `${t.isDefault ? "default" : ""} ${t.isBuiltin ? "builtin" : "custom"}`,
    icon: t.isDefault ? (
      <BadgeCheck className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
    ) : t.isBuiltin ? undefined : (
      <Star className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
    ),
  }));
}

interface ModelLike {
  id: string;
  name: string;
  reasoning?: boolean | null;
  contextWindow?: number | null;
}

export function modelOptions(models: ModelLike[]): ComboboxOption[] {
  return models.map((m) => ({
    value: m.id,
    label: m.name,
    description:
      [
        m.reasoning ? "Reasoning" : null,
        m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k ctx` : null,
      ]
        .filter(Boolean)
        .join(" · ") || undefined,
    keywords: `${m.id} ${m.reasoning ? "reasoning thinking" : ""}`,
    icon: m.reasoning ? (
      <Brain className="h-3.5 w-3.5 shrink-0 text-violet-300" aria-hidden="true" />
    ) : undefined,
  }));
}

export function thinkingLevelOptions(levels: string[]): ComboboxOption[] {
  return levels.map((lvl) => ({
    value: lvl,
    label: lvl === "off" ? "Off (Standard Response)" : `${lvl.charAt(0).toUpperCase() + lvl.slice(1)} Thinking`,
  }));
}

interface LlmProviderLike {
  id: string;
  name: string;
  isConfigured: boolean;
  modelCount: number;
}

export function llmProviderOptions(providers: LlmProviderLike[]): ComboboxOption[] {
  return providers.map((p) => ({
    value: p.id,
    label: p.name,
    description: `${p.modelCount} models · ${p.isConfigured ? "Key configured" : "Needs API key"}`,
    keywords: p.isConfigured ? "configured" : "unconfigured",
    icon: p.isConfigured ? (
      <CircleCheck className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
    ) : (
      <CircleX className="h-3.5 w-3.5 shrink-0 text-base-content/50" aria-hidden="true" />
    ),
  }));
}

export const LOG_LEVEL_OPTIONS: ComboboxOption[] = [
  {
    value: "debug",
    label: "All Levels (DEBUG+)",
    icon: <Bug className="h-3.5 w-3.5 shrink-0 text-base-content/70" aria-hidden="true" />,
  },
  {
    value: "info",
    label: "INFO and above",
    icon: <Info className="h-3.5 w-3.5 shrink-0 text-info" aria-hidden="true" />,
  },
  {
    value: "warn",
    label: "WARN and ERROR only",
    icon: <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />,
  },
  {
    value: "error",
    label: "ERROR only",
    icon: <CircleX className="h-3.5 w-3.5 shrink-0 text-error" aria-hidden="true" />,
  },
];

export function logCategoryOptions(categories: string[]): ComboboxOption[] {
  return [
    { value: "", label: "All Categories" },
    ...categories.map((c) => ({
      value: c,
      label: c,
      icon: <Tag className="h-3.5 w-3.5 shrink-0 text-base-content/50" aria-hidden="true" />,
    })),
  ];
}

/** Reasoning-level label with a Lucide Brain mark (replaces the 🧠 emoji). */
export function ThinkingLabel(): ReactElement {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Brain className="h-3.5 w-3.5 text-violet-300" aria-hidden="true" />
      <span>Thinking / Reasoning Level</span>
    </span>
  );
}

export { Combobox };
