import { useState } from "react";
import type { ChangeEvent, ReactElement } from "react";
import type { OpenApiSchemas } from "../../api/types.ts";
import { Button, Modal, notify } from "../../components/ui";
import { postJson } from "./peopleUtils";

type ImportResult = OpenApiSchemas["SpeakerLibraryImportResult"];
type ImportMode = "merge" | "replace";

const ACTION_LABEL: Record<string, string> = {
  created: "New person",
  merged: "Adds voice",
  skipped: "Already known",
};

const ACTION_TAG: Record<string, string> = {
  created: "tag-green",
  merged: "tag-blue",
  skipped: "",
};

/* Import a voiceprint library exported from another Olive. Always shows a
   dry-run preview before anything is written. */
export function ImportLibraryDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }): ReactElement {
  const [library, setLibrary] = useState<unknown>(null);
  const [fileName, setFileName] = useState("");
  const [mode, setMode] = useState<ImportMode>("merge");
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runPreview = async (lib: unknown, nextMode: ImportMode) => {
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      setPreview(await postJson<ImportResult>("/api/speakers/import", { library: lib, mode: nextMode, dryRun: true }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setPreview(null);
    try {
      const parsed: unknown = JSON.parse(await file.text());
      // Exports are wrapped as { library }; the endpoint accepts either shape.
      const lib =
        parsed && typeof parsed === "object" && "library" in parsed ? (parsed as { library: unknown }).library : parsed;
      setLibrary(lib);
      await runPreview(lib, mode);
    } catch {
      setLibrary(null);
      setError("This file is not a valid voiceprint library (JSON).");
    }
  };

  const handleModeChange = (next: ImportMode) => {
    setMode(next);
    if (library) void runPreview(library, next);
  };

  const handleImport = async () => {
    if (!library) return;
    setBusy(true);
    setError(null);
    try {
      const res = await postJson<ImportResult>("/api/speakers/import", { library, mode, dryRun: false });
      const stats = res.stats;
      notify(
        "success",
        stats ? `Imported ${stats.speakersImported} ${stats.speakersImported === 1 ? "person" : "people"} (${stats.created} new)` : "Library imported",
      );
      onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const stats = preview?.stats;

  return (
    <Modal onClose={onClose} title="Import voice library" ariaLabel="Import voice library" maxWidth="max-w-xl">
      <div className="space-y-4 text-sm">
        <p className="text-base-content/70">
          Load a library exported from another Olive. Voiceprints are matched to people by name; meetings are never imported.
        </p>

        <input
          type="file"
          accept="application/json,.json"
          onChange={(e) => void handleFile(e)}
          aria-label="Voice library file"
          className="file-input w-full"
        />

        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium text-base-content/70">How to import</legend>
          <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-divider p-3 hover:bg-hover">
            <input type="radio" name="import-mode" className="radio radio-sm mt-0.5" checked={mode === "merge"} onChange={() => handleModeChange("merge")} />
            <span>
              <span className="block font-medium">Add to my people</span>
              <span className="block text-base-content/60">New people are created, existing ones gain the extra voiceprints.</span>
            </span>
          </label>
          <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-divider p-3 hover:bg-hover">
            <input type="radio" name="import-mode" className="radio radio-sm mt-0.5" checked={mode === "replace"} onChange={() => handleModeChange("replace")} />
            <span>
              <span className="block font-medium">Replace my people</span>
              <span className="block text-base-content/60">Deletes everyone here first. Meeting attributions carry over by name.</span>
            </span>
          </label>
        </fieldset>

        {busy && !preview && (
          <div className="flex items-center gap-2 text-base-content/60">
            <span className="loading loading-spinner loading-xs" aria-hidden="true" />
            Checking {fileName || "file"}…
          </div>
        )}

        {preview && stats && (
          <div className="space-y-3 rounded-lg border border-divider p-4">
            <p className="font-medium">
              {stats.created} new, {stats.merged} updated, {stats.skipped} already up to date
            </p>
            {preview.plan && preview.plan.length > 0 && (
              <ul className="max-h-56 space-y-1 overflow-y-auto">
                {preview.plan.map((item) => (
                  <li key={`${item.name}-${item.speakerId ?? ""}`} className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate">{item.name}</span>
                    <span className={`tag ${ACTION_TAG[item.action] ?? ""}`}>{ACTION_LABEL[item.action] ?? item.action}</span>
                  </li>
                ))}
              </ul>
            )}
            {preview.warnings && preview.warnings.length > 0 && (
              <ul className="list-disc space-y-1 pl-5 text-xs text-base-content/60">
                {preview.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {error && <div className="alert alert-soft alert-error text-sm">{error}</div>}

        <div className="flex justify-end gap-2 border-t border-divider pt-4">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={mode === "replace" ? "danger" : "primary"}
            onClick={() => void handleImport()}
            disabled={!preview || busy}
          >
            {busy && preview && <span className="loading loading-spinner loading-xs" aria-hidden="true" />}
            {mode === "replace" ? "Replace people" : "Import"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
