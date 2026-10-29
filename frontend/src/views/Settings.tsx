import { useState } from "react";
import type { ReactElement } from "react";
import type { PlaudStatus } from "../lib/common";
import { useTheme, type ThemePreference } from "../components/ui";
import { PlaudModal } from "./AppModals";
import { BackupRestoreView } from "./Backup";
import { LlmSettingsModal } from "./LlmSettings";

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
  const { preference, setPreference } = useTheme();
  const [showLlm, setShowLlm] = useState(false);
  const [showPlaud, setShowPlaud] = useState(false);

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:gap-10">
      <nav aria-label="Settings sections" className="flex gap-1 overflow-x-auto lg:w-52 lg:shrink-0 lg:flex-col">
        {SETTINGS_SECTIONS.map((s) => (
          <button
            key={s.key}
            type="button"
            aria-current={section === s.key ? "page" : undefined}
            onClick={() => onNavigateSection(s.key)}
            className={`shrink-0 rounded-md px-3 py-1.5 text-left text-sm ${section === s.key ? "bg-active font-medium" : "text-base-content/70 hover:bg-hover"}`}
          >
            {s.label}
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1">
        {section === "general" && (
          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold">Appearance</h2>
            <div role="radiogroup" aria-label="Theme" className="flex w-fit rounded-lg bg-hover p-1">
              {(["system", "light", "dark"] as ThemePreference[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  role="radio"
                  aria-checked={preference === p}
                  onClick={() => setPreference(p)}
                  className={`rounded-md px-3 py-1 text-sm capitalize ${preference === p ? "bg-base-100 font-medium shadow-sm" : "text-base-content/70"}`}
                >
                  {p}
                </button>
              ))}
            </div>
          </section>
        )}
        {(section === "transcription" || section === "ai" || section === "speakers") && (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setShowLlm(true)}>
            Open settings
          </button>
        )}
        {section === "integrations" && (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setShowPlaud(true)}>
            {plaudStatus?.connected ? "Plaud: connected" : "Connect Plaud"}
          </button>
        )}
        {section === "data" && <BackupRestoreView onRestoreComplete={onRestoreComplete} />}
      </div>
      {showLlm && (
        <LlmSettingsModal
          onClose={() => setShowLlm(false)}
          onSaved={() => {
            setShowLlm(false);
            onSettingsSaved();
          }}
        />
      )}
      {showPlaud && <PlaudModal status={plaudStatus} onClose={() => setShowPlaud(false)} onRefreshStatus={onRefreshPlaud} />}
    </div>
  );
}
