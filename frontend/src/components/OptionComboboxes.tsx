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
  TriangleAlert,
} from "lucide-react";
import { Combobox } from "./Combobox";
import type { ComboboxOption } from "./Combobox";

/** Transcription provider values used by bulk / settings forms: "local" | "speechmatics" | "assemblyai" | "muse". */
export const TRANSCRIBE_PROVIDER_OPTIONS: ComboboxOption[] = [
  {
    value: "assemblyai",
    label: "AssemblyAI (Cloud)",
    keywords: "cloud",
    icon: <Cloud className="h-3.5 w-3.5 shrink-0 text-sky-300" aria-hidden="true" />,
  },
  {
    value: "muse",
    label: "Muse Voice (Cloud)",
    keywords: "cloud meta",
    icon: <Cloud className="h-3.5 w-3.5 shrink-0 text-sky-300" aria-hidden="true" />,
  },
  {
    value: "speechmatics",
    label: "Speechmatics (Cloud)",
    keywords: "cloud",
    icon: <Cloud className="h-3.5 w-3.5 shrink-0 text-sky-300" aria-hidden="true" />,
  },
  {
    value: "local",
    label: "Local (Cohere + Diarization)",
    keywords: "local on-device cohere",
    icon: <Cpu className="h-3.5 w-3.5 shrink-0 text-lime-300" aria-hidden="true" />,
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
    icon: <Cpu className="h-3.5 w-3.5 shrink-0 text-lime-300" aria-hidden="true" />,
  },
  {
    value: "speechmatics",
    label: "Speechmatics (Cloud)",
    keywords: "cloud",
    icon: <Cloud className="h-3.5 w-3.5 shrink-0 text-sky-300" aria-hidden="true" />,
  },
  {
    value: "assemblyai",
    label: "AssemblyAI (Cloud)",
    keywords: "cloud",
    icon: <Cloud className="h-3.5 w-3.5 shrink-0 text-sky-300" aria-hidden="true" />,
  },
  {
    value: "muse",
    label: "Muse Voice (Cloud)",
    keywords: "cloud meta",
    icon: <Cloud className="h-3.5 w-3.5 shrink-0 text-sky-300" aria-hidden="true" />,
  },
];

export const TRANSCRIPT_PROVIDER_FILTER_OPTIONS: ComboboxOption[] = [
  { value: "any", label: "Any (no filter)" },
  { value: "local", label: "Local" },
  { value: "speechmatics", label: "Speechmatics" },
  { value: "assemblyai", label: "AssemblyAI" },
  { value: "muse", label: "Muse Voice" },
  { value: "plaud", label: "Plaud" },
  { value: "none", label: "No transcript yet" },
];

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
      <BadgeCheck className="h-3.5 w-3.5 shrink-0 text-lime-300" aria-hidden="true" />
    ) : t.isBuiltin ? undefined : (
      <Star className="h-3.5 w-3.5 shrink-0 text-amber-300" aria-hidden="true" />
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
      <CircleCheck className="h-3.5 w-3.5 shrink-0 text-lime-300" aria-hidden="true" />
    ) : (
      <CircleX className="h-3.5 w-3.5 shrink-0 text-stone-500" aria-hidden="true" />
    ),
  }));
}

export const LOG_LEVEL_OPTIONS: ComboboxOption[] = [
  {
    value: "debug",
    label: "All Levels (DEBUG+)",
    icon: <Bug className="h-3.5 w-3.5 shrink-0 text-stone-400" aria-hidden="true" />,
  },
  {
    value: "info",
    label: "INFO and above",
    icon: <Info className="h-3.5 w-3.5 shrink-0 text-sky-300" aria-hidden="true" />,
  },
  {
    value: "warn",
    label: "WARN and ERROR only",
    icon: <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-amber-300" aria-hidden="true" />,
  },
  {
    value: "error",
    label: "ERROR only",
    icon: <CircleX className="h-3.5 w-3.5 shrink-0 text-red-300" aria-hidden="true" />,
  },
];

export function logCategoryOptions(categories: string[]): ComboboxOption[] {
  return [
    { value: "", label: "All Categories" },
    ...categories.map((c) => ({
      value: c,
      label: c,
      icon: <Tag className="h-3.5 w-3.5 shrink-0 text-stone-500" aria-hidden="true" />,
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
