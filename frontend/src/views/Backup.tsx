import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { Download, RotateCw, Save, Trash2, TriangleAlert, Upload } from "lucide-react";
import { Button, Modal, ModalFooter, confirmAction, notify } from "../components/ui";
import type { BackupInfo } from "../api/types.ts";
import { formatDate } from "../lib/common";

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

interface RestoreTarget {
  type: "file" | "stored";
  filename: string;
  sizeBytes?: number;
  meetings?: number;
  audioFiles?: number;
  summaries?: number;
}

function contentsOf(b: BackupInfo): string {
  const s = b.manifest?.stats;
  if (!s) return "Contents unknown";
  const parts = [`${s.meetingCount} meetings`, `${s.audioFilesCount} audio files`];
  if (s.summaryCount !== undefined && s.summaryCount !== null) parts.push(`${s.summaryCount} summaries`);
  return parts.join(" · ");
}

const LINK_BUTTON =
  "inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[13px] whitespace-nowrap hover:bg-hover max-sm:min-h-11 max-sm:flex-1 max-sm:justify-center max-sm:border max-sm:border-base-content/12";

function RestoreDialog({
  target,
  restoring,
  onCancel,
  onConfirm,
}: {
  target: RestoreTarget;
  restoring: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactElement {
  const [acknowledged, setAcknowledged] = useState(false);
  return (
    <Modal
      onClose={() => !restoring && onCancel()}
      title="Restore this backup?"
      ariaLabel="Confirm system restore"
      maxWidth="max-w-md"
      footer={
        <ModalFooter>
          <Button variant="secondary" onClick={onCancel} disabled={restoring}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={restoring || !acknowledged}>
            {restoring && <span className="loading loading-spinner loading-xs" aria-hidden="true" />}
            {restoring ? "Restoring…" : "Replace everything"}
          </Button>
        </ModalFooter>
      }
    >
      <div className="flex gap-3 rounded-lg bg-[color:var(--tag-red-bg)] px-3 py-2.5 text-[color:var(--tag-red)]">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <p className="text-[13px] leading-relaxed">
          Every meeting, recording, transcript, summary, person, template and setting on this server is replaced by the contents of the backup.
          Anything created after it was made is lost.
        </p>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
        <dt className="text-base-content/60">Backup</dt>
        <dd className="min-w-0 font-mono break-all">{target.filename}</dd>
        {target.sizeBytes ? (
          <>
            <dt className="text-base-content/60">Size</dt>
            <dd>{formatBytes(target.sizeBytes)}</dd>
          </>
        ) : null}
        {target.meetings ? (
          <>
            <dt className="text-base-content/60">Meetings</dt>
            <dd>{target.meetings}</dd>
          </>
        ) : null}
        {target.audioFiles ? (
          <>
            <dt className="text-base-content/60">Audio files</dt>
            <dd>{target.audioFiles}</dd>
          </>
        ) : null}
        {target.summaries ? (
          <>
            <dt className="text-base-content/60">Summaries</dt>
            <dd>{target.summaries}</dd>
          </>
        ) : null}
      </dl>
      <p className="text-[13px] text-base-content/65">Olive keeps a rollback copy of the current state while restoring, in case something goes wrong.</p>
      <label className="flex items-start gap-2.5 max-sm:min-h-11">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.target.checked)}
          disabled={restoring}
          className="checkbox checkbox-sm checkbox-error mt-0.5 rounded"
        />
        <span className="text-[13px]">I understand the current data will be replaced.</span>
      </label>
    </Modal>
  );
}

export function BackupRestoreView({ onRestoreComplete }: { onRestoreComplete: () => void }): ReactElement {
  const [backups, setBackups] = useState<BackupInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [confirmRestoreTarget, setConfirmRestoreTarget] = useState<RestoreTarget | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadBackups = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/backup/list");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { backups?: BackupInfo[] };
      setBackups(data.backups || []);
    } catch {
      setLoadError("Could not load the snapshot list from the server.");
      setBackups((prev) => prev ?? []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadBackups();
  }, []);

  const handleCreateServerBackup = async () => {
    setCreating(true);
    try {
      const res = await fetch("/api/backup", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to create backup");
      }
      notify(
        "success",
        `Snapshot saved (${formatBytes(data.backup.sizeBytes)}): ${data.backup.manifest.stats.meetingCount} meetings, ${data.backup.manifest.stats.audioFilesCount} audio files.`
      );
      await loadBackups();
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteBackup = async (filename: string) => {
    if (
      !(await confirmAction({
        title: "Delete snapshot",
        message: `Delete the snapshot "${filename}" from the server? This cannot be undone.`,
        confirmLabel: "Delete",
        danger: true,
      }))
    ) {
      return;
    }
    try {
      const res = await fetch(`/api/backup/${encodeURIComponent(filename)}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to delete backup");
      }
      notify("success", `Deleted ${filename}`);
      await loadBackups();
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    }
  };

  const handleExecuteRestore = async () => {
    if (!confirmRestoreTarget) return;
    setRestoring(true);

    try {
      let res: Response;
      if (confirmRestoreTarget.type === "file" && selectedFile) {
        const formData = new FormData();
        formData.append("file", selectedFile);
        res = await fetch("/api/backup/restore", {
          method: "POST",
          body: formData,
        });
      } else if (confirmRestoreTarget.type === "stored" && confirmRestoreTarget.filename) {
        res = await fetch("/api/backup/restore", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: confirmRestoreTarget.filename }),
        });
      } else {
        throw new Error("No restore target selected");
      }

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Restore operation failed");
      }

      notify(
        "success",
        `Restore complete: ${data.result.stats.meetings} meetings, ${data.result.stats.audioFiles} audio files, ${data.result.stats.summaries} summaries and ${data.result.stats.speakers} people.`
      );

      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setConfirmRestoreTarget(null);
      onRestoreComplete();
      await loadBackups();
    } catch (err) {
      notify("error", `Restore failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRestoring(false);
      setConfirmRestoreTarget(null);
    }
  };

  const askRestoreStored = (b: BackupInfo) =>
    setConfirmRestoreTarget({
      type: "stored",
      filename: b.filename,
      sizeBytes: b.sizeBytes,
      meetings: b.manifest?.stats.meetingCount ?? 0,
      audioFiles: b.manifest?.stats.audioFilesCount ?? 0,
      summaries: b.manifest?.stats.summaryCount ?? 0,
    });

  const actions = (b: BackupInfo) => (
    <>
      <a href={`/api/backup/download/${encodeURIComponent(b.filename)}`} download className={LINK_BUTTON} aria-label={`Download ${b.filename}`}>
        <Download className="h-3.5 w-3.5" aria-hidden="true" />
        Download
      </a>
      <button type="button" onClick={() => askRestoreStored(b)} className={LINK_BUTTON} aria-label={`Restore ${b.filename}`}>
        <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
        Restore…
      </button>
      <button
        type="button"
        onClick={() => void handleDeleteBackup(b.filename)}
        className={`${LINK_BUTTON} text-error hover:bg-error/10`}
        aria-label={`Delete ${b.filename}`}
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
        Delete
      </button>
    </>
  );

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap gap-2">
        <a href="/api/backup/export" download className="btn btn-primary h-9 rounded-md border-0 px-3.5 text-sm font-medium shadow-none max-sm:min-h-11 max-sm:flex-1">
          <Download className="h-4 w-4" aria-hidden="true" />
          Download backup
        </a>
        <Button onClick={() => void handleCreateServerBackup()} disabled={creating} className="max-sm:flex-1">
          {creating ? <span className="loading loading-spinner loading-xs" aria-hidden="true" /> : <Save className="h-4 w-4" aria-hidden="true" />}
          {creating ? "Saving snapshot…" : "Save snapshot on server"}
        </Button>
      </div>

      <section aria-labelledby="restore-file-title" className="flex flex-col gap-2">
        <h3 id="restore-file-title" className="text-[15px] font-semibold">
          Restore from a file
        </h3>
        <p className="text-[13px] text-base-content/65">
          Pick an Olive <code className="font-mono">.tar.gz</code> backup from your computer. You confirm before anything is replaced.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInputRef}
            id="restore-file"
            type="file"
            accept=".tar.gz,.tgz,application/gzip,application/x-gzip"
            className="sr-only"
            onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
          />
          <label
            htmlFor="restore-file"
            className="btn h-9 cursor-pointer rounded-md border-base-content/15 bg-transparent px-3.5 text-sm font-medium shadow-none hover:bg-hover max-sm:min-h-11"
          >
            <Upload className="h-4 w-4" aria-hidden="true" />
            Choose file…
          </label>
          {selectedFile ? (
            <>
              <span className="min-w-0 max-w-full truncate text-[13px]" title={selectedFile.name}>
                {selectedFile.name} <span className="text-base-content/60">· {formatBytes(selectedFile.size)}</span>
              </span>
              <Button
                variant="danger"
                size="sm"
                onClick={() => setConfirmRestoreTarget({ type: "file", filename: selectedFile.name, sizeBytes: selectedFile.size })}
              >
                Restore…
              </Button>
            </>
          ) : (
            <span className="text-[13px] text-base-content/60">No file chosen</span>
          )}
        </div>
      </section>

      <section aria-labelledby="snapshots-title" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="snapshots-title" className="text-[15px] font-semibold">
            Snapshots on the server
          </h3>
          <Button size="sm" variant="ghost" onClick={() => void loadBackups()} disabled={loading} className="text-base-content/70">
            <RotateCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
            Refresh
          </Button>
        </div>
        {loadError && (
          <p role="alert" className="text-[13px] text-error">
            {loadError}
          </p>
        )}

        {backups === null ? (
          <div className="rounded-[10px] border border-base-content/12 px-4 py-8 text-center text-sm text-base-content/60">Loading snapshots…</div>
        ) : backups.length === 0 ? (
          <div className="rounded-[10px] border border-base-content/12 px-4 py-8 text-center text-sm text-base-content/60">
            No snapshots on the server yet. Save one above, or download a backup to keep it on your computer.
          </div>
        ) : (
          <>
            <div className="hidden overflow-x-auto rounded-[10px] border border-base-content/12 sm:block">
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr className="text-left text-base-content/60">
                    <th className="px-3.5 py-2.5 font-normal">Created</th>
                    <th className="px-3.5 py-2.5 font-normal">Size</th>
                    <th className="px-3.5 py-2.5 font-normal">Contents</th>
                    <th className="px-3.5 py-2.5">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {backups.map((b) => (
                    <tr key={b.filename} className="border-t border-divider">
                      <td className="px-3.5 py-2.5">
                        <span className="block font-medium">{formatDate(new Date(b.createdAt).getTime())}</span>
                        <span className="block max-w-[16rem] truncate font-mono text-xs text-base-content/50" title={b.filename}>
                          {b.filename}
                        </span>
                      </td>
                      <td className="px-3.5 py-2.5 whitespace-nowrap text-base-content/70">{formatBytes(b.sizeBytes)}</td>
                      <td className="px-3.5 py-2.5 text-base-content/70">
                        {contentsOf(b)}
                        {b.manifest?.stats.totalAudioSizeBytes ? (
                          <span className="text-base-content/50"> ({formatBytes(b.manifest.stats.totalAudioSizeBytes)} audio)</span>
                        ) : null}
                      </td>
                      <td className="px-2 py-1.5 text-right whitespace-nowrap">{actions(b)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="rounded-[10px] border border-base-content/12 sm:hidden">
              {backups.map((b) => (
                <li key={b.filename} className="flex flex-col gap-2 border-b border-divider p-3.5 last:border-b-0">
                  <div>
                    <div className="font-medium">{formatDate(new Date(b.createdAt).getTime())}</div>
                    <div className="text-[13px] text-base-content/65">
                      {formatBytes(b.sizeBytes)} · {contentsOf(b)}
                    </div>
                    <div className="truncate font-mono text-xs text-base-content/50">{b.filename}</div>
                  </div>
                  <div className="flex gap-2">{actions(b)}</div>
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="text-[13px] text-base-content/65">Restoring replaces everything. Download a backup first if you may want the current state back.</p>
      </section>

      {confirmRestoreTarget && (
        <RestoreDialog
          target={confirmRestoreTarget}
          restoring={restoring}
          onCancel={() => setConfirmRestoreTarget(null)}
          onConfirm={() => void handleExecuteRestore()}
        />
      )}
    </div>
  );
}
