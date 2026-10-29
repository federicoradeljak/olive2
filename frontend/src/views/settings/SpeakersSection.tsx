import { useRef, useState } from "react";
import type { ReactElement } from "react";
import { Download, Upload } from "lucide-react";
import { Button, Modal, ModalFooter, notify } from "../../components/ui";
import { SecretField, SectionHeader, Segmented, SettingsRow, SettingsRows, ThresholdSlider, errorText, readError, type AppConfigDto } from "./shared";

interface ImportStats {
  created?: number;
  merged?: number;
  skipped?: number;
  vectorsImported?: number;
}

interface ImportResult {
  stats?: ImportStats;
  warnings?: string[];
}

function describeStats(stats: ImportStats | undefined): string {
  if (!stats) return "No changes.";
  return `${stats.created ?? 0} new, ${stats.merged ?? 0} merged, ${stats.skipped ?? 0} skipped`;
}

function VoiceLibrary({ onImported }: { onImported: () => void }): ReactElement {
  const fileRef = useRef<HTMLInputElement>(null);
  const [exporting, setExporting] = useState(false);
  const [pending, setPending] = useState<{ name: string; library: unknown; preview: ImportResult } | null>(null);
  const [mode, setMode] = useState<"merge" | "replace">("merge");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleExport = async () => {
    setExporting(true);
    try {
      const res = await fetch("/api/speakers/export");
      if (!res.ok) throw new Error(await readError(res, "Export failed"));
      const data = (await res.json()) as { library: unknown };
      const blob = new Blob([JSON.stringify(data.library, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `olive-voiceprints-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      notify("error", errorText(err));
    } finally {
      setExporting(false);
    }
  };

  const runImport = async (library: unknown, importMode: "merge" | "replace", dryRun: boolean): Promise<ImportResult> => {
    const res = await fetch("/api/speakers/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ library, mode: importMode, dryRun }),
    });
    if (!res.ok) throw new Error(await readError(res, "Import failed"));
    return (await res.json()) as ImportResult;
  };

  const handleFile = async (file: File) => {
    setError(null);
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const library = parsed && typeof parsed === "object" && "library" in parsed ? (parsed as { library: unknown }).library : parsed;
      const preview = await runImport(library, "merge", true);
      setMode("merge");
      setPending({ name: file.name, library, preview });
    } catch (err) {
      const message = err instanceof SyntaxError ? "That file is not a valid voice library (JSON expected)." : errorText(err);
      notify("error", message);
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const handleConfirm = async () => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      const result = await runImport(pending.library, mode, false);
      notify("success", `Voice library imported: ${describeStats(result.stats)}.`);
      setPending(null);
      onImported();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
          }}
        />
        <Button size="sm" onClick={() => fileRef.current?.click()}>
          <Upload className="h-3.5 w-3.5" aria-hidden="true" />
          Import…
        </Button>
        <Button size="sm" onClick={() => void handleExport()} disabled={exporting}>
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
          {exporting ? "Exporting…" : "Export"}
        </Button>
      </div>

      {pending && (
        <Modal
          onClose={() => !busy && setPending(null)}
          title="Import voice library"
          ariaLabel="Import voice library"
          maxWidth="max-w-md"
          footer={
            <ModalFooter>
              <Button variant="secondary" onClick={() => setPending(null)} disabled={busy}>
                Cancel
              </Button>
              <Button variant={mode === "replace" ? "danger" : "primary"} onClick={() => void handleConfirm()} disabled={busy}>
                {busy && <span className="loading loading-spinner loading-xs" aria-hidden="true" />}
                {mode === "replace" ? "Replace library" : "Import"}
              </Button>
            </ModalFooter>
          }
        >
          <p className="text-base-content/80">
            <span className="font-medium text-base-content">{pending.name}</span> · preview: {describeStats(pending.preview.stats)}.
          </p>
          <div className="flex flex-col gap-2">
            <span className="text-[13px] font-medium text-base-content/70">How to import</span>
            <Segmented
              ariaLabel="Import mode"
              value={mode}
              onChange={setMode}
              options={[
                { value: "merge", label: "Merge with mine" },
                { value: "replace", label: "Replace mine" },
              ]}
            />
            <p className="text-[13px] text-base-content/65">
              {mode === "merge"
                ? "Voices are added to people with the same name; everyone else is created."
                : "Your current voice library is cleared first. Names on past meetings are kept."}
            </p>
          </div>
          {pending.preview.warnings && pending.preview.warnings.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-[13px] text-warning">
              {pending.preview.warnings.slice(0, 5).map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          {error && (
            <p role="alert" className="text-[13px] text-error">
              {error}
            </p>
          )}
        </Modal>
      )}
    </>
  );
}

export function SpeakersSection({
  draft,
  saved,
  onChange,
  onLibraryChanged,
}: {
  draft: AppConfigDto;
  saved: AppConfigDto;
  onChange: <K extends keyof AppConfigDto>(key: K, value: AppConfigDto[K]) => void;
  onLibraryChanged: () => void;
}): ReactElement {
  return (
    <section aria-labelledby="settings-speakers">
      <SectionHeader
        id="settings-speakers"
        title="Speaker recognition"
        description="How the local pipeline tells voices apart and names people it already knows."
      />
      <SettingsRows>
        <SettingsRow
          label="Hugging Face token"
          htmlFor="hf-token"
          hint={
            <>
              Needed once to download the voice separation model. Accept the terms of{" "}
              <a
                href="https://huggingface.co/pyannote/speaker-diarization-community-1"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline underline-offset-2"
              >
                pyannote/speaker-diarization-community-1
              </a>{" "}
              first.
            </>
          }
        >
          <SecretField
            id="hf-token"
            label="Hugging Face token"
            value={draft.hfToken}
            savedValue={saved.hfToken}
            onChange={(v) => onChange("hfToken", v)}
            placeholder="hf_…"
            envName="HF_TOKEN"
            effective={saved.hasHfToken}
          />
        </SettingsRow>
        <SettingsRow
          label="Separate voices"
          hint="How different two voices must sound to count as different people in one meeting. Move toward Stricter if two people get merged into one speaker, toward Looser if one person is split in two."
        >
          <ThresholdSlider
            label="Separate voices"
            value={draft.localClusteringThreshold}
            onChange={(v) => onChange("localClusteringThreshold", v)}
            recommended={0.5}
          />
        </SettingsRow>
        <SettingsRow
          label="Recognize known people"
          hint="How closely a voice must match someone in People before Olive names them. Move toward Looser if Olive misses people you already named, toward Stricter if it names the wrong person."
        >
          <ThresholdSlider
            label="Recognize known people"
            value={draft.localSimilarityThreshold}
            onChange={(v) => onChange("localSimilarityThreshold", v)}
            recommended={0.45}
          />
        </SettingsRow>
        <SettingsRow label="Voice library" hint="Move known people and their voiceprints between Olive installs. Audio is not included.">
          <VoiceLibrary onImported={onLibraryChanged} />
        </SettingsRow>
      </SettingsRows>
    </section>
  );
}
