import type { ReactElement } from "react";
import { Combobox } from "../../components/Combobox";
import { SUMMARY_AUTO_LABEL, TRANSCRIPTION_AUTO_LABEL, languageOptions, templateOptions } from "../../components/OptionComboboxes";
import { useTheme, type ThemePreference } from "../../components/ui";
import type { Template } from "../../api/types.ts";
import { SectionHeader, Segmented, SettingsRow, SettingsRows, type AppConfigDto } from "./shared";

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const TRANSCRIPTION_LANGUAGE_OPTIONS = languageOptions("Engine default (English on local / Speechmatics)", TRANSCRIPTION_AUTO_LABEL);
const SUMMARY_LANGUAGE_OPTIONS = languageOptions("Template default", SUMMARY_AUTO_LABEL);

export function GeneralSection({
  draft,
  onChange,
  templates,
  defaultTemplateId,
  onDefaultTemplateChange,
}: {
  draft: AppConfigDto;
  onChange: <K extends keyof AppConfigDto>(key: K, value: AppConfigDto[K]) => void;
  templates: Template[] | null;
  defaultTemplateId: string;
  onDefaultTemplateChange: (id: string) => void;
}): ReactElement {
  const { preference, setPreference } = useTheme();

  return (
    <section aria-labelledby="settings-general">
      <SectionHeader id="settings-general" title="General" description="How Olive looks and which languages it uses by default." />
      <SettingsRows>
        <SettingsRow label="Appearance" hint="System follows your computer's light or dark setting. Saved on this device right away.">
          <Segmented ariaLabel="Appearance" value={preference} options={THEME_OPTIONS} onChange={setPreference} />
        </SettingsRow>
        <SettingsRow
          label="Transcription language"
          hint="Used for uploads, Plaud syncs and bulk jobs unless a transcription picks another one."
        >
          <Combobox
            value={draft.defaultTranscriptionLanguage}
            onChange={(v) => onChange("defaultTranscriptionLanguage", v)}
            ariaLabel="Default transcription language"
            placeholder="Select language…"
            searchPlaceholder="Search languages…"
            options={TRANSCRIPTION_LANGUAGE_OPTIONS}
          />
        </SettingsRow>
        <SettingsRow
          label="Summary language"
          hint={<>Summaries and auto-summaries. Templates can reference it with {"{{language}}"}.</>}
        >
          <Combobox
            value={draft.defaultSummaryLanguage}
            onChange={(v) => onChange("defaultSummaryLanguage", v)}
            ariaLabel="Default summary language"
            placeholder="Select language…"
            searchPlaceholder="Search languages…"
            options={SUMMARY_LANGUAGE_OPTIONS}
          />
        </SettingsRow>
        <SettingsRow label="Default summary template" hint="Pre-selected when you create a summary and used for auto-summaries.">
          {templates === null ? (
            <span className="text-sm text-base-content/60">Loading templates…</span>
          ) : templates.length === 0 ? (
            <span className="text-sm text-base-content/60">No templates yet.</span>
          ) : (
            <Combobox
              value={defaultTemplateId}
              onChange={onDefaultTemplateChange}
              ariaLabel="Default summary template"
              placeholder="Select template…"
              searchPlaceholder="Search templates…"
              options={templateOptions(templates)}
            />
          )}
        </SettingsRow>
      </SettingsRows>
    </section>
  );
}
