import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { CheckCircle2, Download, Info, RefreshCw, RotateCw, Save, Trash2, X, XCircle } from "lucide-react";
import { confirmAction } from "../components/ui";
import type { BackupInfo } from "../api/types.ts";
import { formatDate } from "../lib/common";
import { Modal } from "./AppModals";

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

export function BackupRestoreView({ onRestoreComplete }: { onRestoreComplete: () => void }): ReactElement {
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [statusMessage, setStatusMessage] = useState<{ type: "success" | "error" | "info"; text: string } | null>(null);
  const [confirmRestoreTarget, setConfirmRestoreTarget] = useState<{
    type: "file" | "stored";
    filename?: string;
    stats?: { meetings: number; audioFiles: number; sizeBytes?: number };
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadBackups = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/backup/list");
      if (res.ok) {
        const data = await res.json();
        setBackups(data.backups || []);
      }
    } catch {
      setStatusMessage({ type: "error", text: "Failed to fetch backup list from server." });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadBackups();
  }, []);

  const handleCreateServerBackup = async () => {
    setCreating(true);
    setStatusMessage(null);
    try {
      const res = await fetch("/api/backup", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to create backup");
      }
      setStatusMessage({
        type: "success",
        text: `Backup created successfully (${formatBytes(data.backup.sizeBytes)}). Included ${data.backup.manifest.stats.meetingCount} meetings & ${data.backup.manifest.stats.audioFilesCount} audio files.`
      });
      await loadBackups();
    } catch (err) {
      setStatusMessage({ type: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteBackup = async (filename: string) => {
    if (!(await confirmAction({ title: "Delete backup", message: `Are you sure you want to delete backup archive "${filename}" from server?`, confirmLabel: "Delete", danger: true }))) {
      return;
    }
    try {
      const res = await fetch(`/api/backup/${encodeURIComponent(filename)}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to delete backup");
      }
      setStatusMessage({ type: "success", text: `Deleted backup ${filename}` });
      await loadBackups();
    } catch (err) {
      setStatusMessage({ type: "error", text: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleExecuteRestore = async () => {
    if (!confirmRestoreTarget) return;
    setRestoring(true);
    setStatusMessage(null);

    try {
      let res: Response;
      if (confirmRestoreTarget.type === "file" && selectedFile) {
        const formData = new FormData();
        formData.append("file", selectedFile);
        res = await fetch("/api/backup/restore", {
          method: "POST",
          body: formData
        });
      } else if (confirmRestoreTarget.type === "stored" && confirmRestoreTarget.filename) {
        res = await fetch("/api/backup/restore", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: confirmRestoreTarget.filename })
        });
      } else {
        throw new Error("No restore target selected");
      }

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Restore operation failed");
      }

      setStatusMessage({
        type: "success",
        text: `Restore complete! Successfully restored ${data.result.stats.meetings} meetings, ${data.result.stats.audioFiles} audio files, ${data.result.stats.summaries} summaries, and ${data.result.stats.speakers} speakers.`
      });

      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setConfirmRestoreTarget(null);
      onRestoreComplete();
      await loadBackups();
    } catch (err) {
      setStatusMessage({ type: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setRestoring(false);
      setConfirmRestoreTarget(null);
    }
  };

  const backupActions = (b: BackupInfo) => (
    <>
      <a
        href={`/api/backup/download/${encodeURIComponent(b.filename)}`}
        download
        className="inline-flex min-h-[44px] flex-1 items-center justify-center whitespace-nowrap rounded border border-base-300 bg-base-300 px-2.5 py-1 text-xs text-base-content hover:bg-base-300 hover:text-white transition sm:min-h-0 sm:flex-none"
      >
        <Download className="h-4 w-4 shrink-0" aria-hidden="true" /> Download
      </a>
      <button
        type="button"
        onClick={() => {
          setConfirmRestoreTarget({
            type: "stored",
            filename: b.filename,
            stats: {
              meetings: b.manifest?.stats.meetingCount ?? 0,
              audioFiles: b.manifest?.stats.audioFilesCount ?? 0,
              sizeBytes: b.sizeBytes
            }
          });
        }}
        className="inline-flex min-h-[44px] flex-1 items-center justify-center whitespace-nowrap rounded border border-warning/40 bg-warning/10 px-2.5 py-1 text-xs text-warning hover:bg-warning/20 transition sm:min-h-0 sm:flex-none"
      >
        <RefreshCw className="h-4 w-4 shrink-0" aria-hidden="true" /> Restore
      </button>
      <button
        type="button"
        onClick={() => void handleDeleteBackup(b.filename)}
        className="btn btn-error btn-soft btn-sm inline-flex min-h-[44px] flex-1 items-center justify-center whitespace-nowrap border border-error/30 text-error hover:bg-error/20 sm:min-h-0 sm:flex-none"
      >
        <Trash2 className="h-4 w-4 shrink-0" aria-hidden="true" /> Delete
      </button>
    </>
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-base-content">Backup & Restore</h1>
          <p className="text-sm text-base-content/70">
            Create complete portable archives of your database, settings, templates, transcripts, notes, and all audio files.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <a
            href="/api/backup/export"
            download
            className="btn btn-primary btn-sm min-h-11"
          >
            <span><Download className="h-4 w-4 shrink-0" aria-hidden="true" /></span>
            <span>Download Full Backup (.tar.gz)</span>
          </a>
          <button
            type="button"
            onClick={() => void handleCreateServerBackup()}
            disabled={creating}
            className="btn btn-sm inline-flex items-center gap-2 bg-base-200 font-semibold min-h-11"
          >
            <span><Save className="h-4 w-4 shrink-0" aria-hidden="true" /></span>
            <span>{creating ? "Creating Snapshot…" : "Save Server Snapshot"}</span>
          </button>
        </div>
      </div>

      {/* Status Alert */}
      {statusMessage && (
        <div
          className={`rounded-xl border p-4 text-sm flex items-start justify-between ${
            statusMessage.type === "success"
              ? "border-primary/40 bg-primary/10 text-primary"
              : statusMessage.type === "error"
              ? "border-error/40 bg-error/10 text-error"
              : "border-accent/40 bg-accent/10 text-accent"
          }`}
        >
          <div className="flex items-center gap-3">
            <span>{statusMessage.type === "success" ? <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" /> : statusMessage.type === "error" ? <XCircle className="h-4 w-4 shrink-0" aria-hidden="true" /> : <Info className="h-4 w-4 shrink-0" aria-hidden="true" />}</span>
            <span>{statusMessage.text}</span>
          </div>
          <button
            type="button"
            onClick={() => setStatusMessage(null)}
            className="text-base-content/70 hover:text-base-content text-xs px-2"
          >
            <X className="h-4 w-4 shrink-0" aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Restore from Upload Box */}
      <div className="rounded-xl border border-base-300 bg-base-200/60 p-5 backdrop-blur">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-base-content mb-2">
          Restore from Backup Archive
        </h2>
        <p className="text-xs text-base-content/70 mb-4">
          Select an Olive <code className="text-base-content">.tar.gz</code> archive from your computer. All meetings, audio recordings, transcripts, summaries, and configuration will be restored.
        </p>

        <div className="flex flex-col sm:flex-row items-center gap-4">
          <input
            ref={fileInputRef}
            type="file"
            accept=".tar.gz,.tgz,application/gzip,application/x-gzip"
            onChange={(e) => {
              const file = e.target.files?.[0] || null;
              setSelectedFile(file);
            }}
            className="block min-h-[44px] w-full text-base text-base-content/70 file:mr-4 file:min-h-[44px] file:rounded-lg file:border-0 file:bg-base-300 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-primary hover:file:bg-base-300 cursor-pointer sm:min-h-0 sm:text-xs sm:file:min-h-0 sm:file:text-xs"
          />
          {selectedFile && (
            <button
              type="button"
              onClick={() => {
                setConfirmRestoreTarget({
                  type: "file",
                  filename: selectedFile.name,
                  stats: { meetings: 0, audioFiles: 0, sizeBytes: selectedFile.size }
                });
              }}
              className="btn btn-warning min-h-[44px] w-full whitespace-nowrap shadow sm:w-auto sm:min-h-0 sm:text-xs"
            >
              Restore Uploaded File
            </button>
          )}
        </div>
      </div>

      {/* Saved Backups Table */}
      <div className="rounded-xl border border-base-300 bg-base-200/60 backdrop-blur overflow-hidden">
        <div className="flex items-center justify-between border-b border-base-300 px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wider text-base-content">
              Server Backup Snapshots
            </h2>
            <p className="text-xs text-base-content/50">Stored on server persistent storage</p>
          </div>
          <button
            type="button"
            onClick={() => void loadBackups()}
            disabled={loading}
            className="btn btn-sm bg-base-100/60 min-h-11"
          >
            {loading ? "Refreshing…" : <><RotateCw className="h-4 w-4 shrink-0" aria-hidden="true" /> Refresh List</>}
          </button>
        </div>

        {backups.length === 0 ? (
          <div className="p-8 text-center text-base-content/50 text-sm">
            No backup snapshots currently saved on the server. Click &ldquo;Save Server Snapshot&rdquo; or &ldquo;Download Full Backup&rdquo; above.
          </div>
        ) : (
          <>
          <div className="hidden overflow-x-auto sm:block">
            <table className="table table-xs w-full text-left text-base-content/80">
              <thead className="border-b border-base-300 bg-base-100/40 text-base-content/70 font-medium">
                <tr>
                  <th className="px-5 py-3">Archive File</th>
                  <th className="px-5 py-3">Created</th>
                  <th className="px-5 py-3">Size</th>
                  <th className="px-5 py-3">Meetings</th>
                  <th className="px-5 py-3">Audio Recordings</th>
                  <th className="px-5 py-3">Summaries</th>
                  <th className="px-5 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-base-300/60">
                {backups.map((b) => (
                  <tr key={b.filename} className="hover:bg-base-300/30 transition">
                    <td className="px-5 py-3.5 font-mono text-primary font-medium">
                      {b.filename}
                    </td>
                    <td className="px-5 py-3.5 text-base-content/70">
                      {formatDate(new Date(b.createdAt).getTime())}
                    </td>
                    <td className="px-5 py-3.5 font-mono text-base-content">
                      {formatBytes(b.sizeBytes)}
                    </td>
                    <td className="px-5 py-3.5">
                      <span className="rounded bg-base-300 px-2 py-0.5 font-mono text-base-content">
                        {b.manifest?.stats.meetingCount ?? "—"}
                      </span>
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-1.5">
                        <span className="rounded bg-base-300 px-2 py-0.5 font-mono text-base-content">
                          {b.manifest?.stats.audioFilesCount ?? "—"} files
                        </span>
                        {b.manifest?.stats.totalAudioSizeBytes ? (
                          <span className="text-[10px] text-base-content/50 font-mono">
                            ({formatBytes(b.manifest.stats.totalAudioSizeBytes)})
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-5 py-3.5">
                      <span className="rounded bg-base-300 px-2 py-0.5 font-mono text-base-content">
                        {b.manifest?.stats.summaryCount ?? "—"}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <div className="flex items-center justify-end gap-2">{backupActions(b)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="divide-y divide-base-300/60 sm:hidden">
            {backups.map((b) => (
              <li key={b.filename} className="space-y-3 p-4">
                <div>
                  <div className="break-all font-mono text-sm font-medium text-primary">{b.filename}</div>
                  <div className="mt-1 text-xs text-base-content/70">
                    {formatDate(new Date(b.createdAt).getTime())} · <span className="font-mono text-base-content">{formatBytes(b.sizeBytes)}</span>
                  </div>
                </div>
                <dl className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <dt className="text-base-content/50">Meetings</dt>
                    <dd className="font-mono text-base-content">{b.manifest?.stats.meetingCount ?? "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-base-content/50">Audio</dt>
                    <dd className="font-mono text-base-content">{b.manifest?.stats.audioFilesCount ?? "—"} files</dd>
                  </div>
                </dl>
                <div className="flex flex-wrap gap-2">{backupActions(b)}</div>
              </li>
            ))}
          </ul>
          </>
        )}
      </div>

      {/* Confirmation Modal for Restore */}
      {confirmRestoreTarget && (
        <div className="fixed inset-0 z-50 flex max-h-[100dvh] items-center justify-center overflow-y-auto bg-base-100/80 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Confirm system restore">
          <div className="my-auto w-full max-w-lg rounded-2xl border border-warning/40 bg-base-200 p-6 shadow-2xl space-y-4">
            <div className="flex items-center gap-3 text-warning">
              <span className="text-2xl">⚠️</span>
              <h3 className="text-lg font-bold text-base-content">Confirm System Restore</h3>
            </div>

            <p className="text-sm text-base-content leading-relaxed">
              Restoring from <strong className="text-warning font-mono">{confirmRestoreTarget.filename}</strong> will overwrite current meetings, audio recordings, transcripts, summaries, and configuration with the contents of this archive.
            </p>

            <div className="rounded-xl border border-base-300 bg-base-100 p-4 space-y-1.5 text-xs text-base-content/70">
              <div className="flex justify-between">
                <span>Source Archive:</span>
                <span className="font-mono text-base-content">{confirmRestoreTarget.filename}</span>
              </div>
              {confirmRestoreTarget.stats?.sizeBytes && (
                <div className="flex justify-between">
                  <span>Archive Size:</span>
                  <span className="font-mono text-base-content">{formatBytes(confirmRestoreTarget.stats.sizeBytes)}</span>
                </div>
              )}
              {confirmRestoreTarget.stats?.meetings ? (
                <div className="flex justify-between">
                  <span>Meetings included:</span>
                  <span className="font-mono text-base-content">{confirmRestoreTarget.stats.meetings}</span>
                </div>
              ) : null}
              {confirmRestoreTarget.stats?.audioFiles ? (
                <div className="flex justify-between">
                  <span>Audio recordings included:</span>
                  <span className="font-mono text-base-content">{confirmRestoreTarget.stats.audioFiles}</span>
                </div>
              ) : null}
            </div>

            <p className="text-xs text-base-content/50">
              Note: An automatic rollback snapshot will be created in temporary storage before file replacement in case of unexpected errors.
            </p>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setConfirmRestoreTarget(null)}
                disabled={restoring}
                className="btn btn-sm min-h-11"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleExecuteRestore()}
                disabled={restoring}
                className="btn btn-warning btn-sm inline-flex items-center gap-2 font-bold shadow min-h-11"
              >
                {restoring ? "Restoring System…" : "Yes, Restore System"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
