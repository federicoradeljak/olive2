import { useEffect, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { Button, Modal as UiModal, ModalFooter, notify } from "../components/ui";
import { PlaudStatus, formatDate, MarkdownRenderer } from "../lib/common";
import { PlaudConnect } from "./settings/PlaudConnect";

export function Modal({
  onClose,
  title,
  ariaLabel,
  maxWidth = "max-w-lg",
  footer,
  children
}: {
  onClose: () => void;
  title: ReactNode;
  ariaLabel: string;
  maxWidth?: string;
  /** Optional pinned footer (use <ModalFooter> from components/ui). */
  footer?: ReactNode;
  children: ReactNode;
}): ReactElement {
  return (
    <UiModal onClose={onClose} title={title} ariaLabel={ariaLabel} maxWidth={maxWidth} footer={footer}>
      {children}
    </UiModal>
  );
}

export function ChangelogModal({ onClose }: { onClose: () => void }): ReactElement {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/changelog")
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<{ version: string; markdown: string }>;
      })
      .then((data) => {
        if (cancelled) return;
        setVersion(data.version);
        setMarkdown(data.markdown);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Modal
      onClose={onClose}
      title={
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span>What's new</span>
          {version && <span className="text-[13px] font-normal text-base-content/55">{version}</span>}
        </span>
      }
      ariaLabel="Olive changelog"
      maxWidth="max-w-2xl"
    >
      {error ? (
        <p role="alert" className="rounded-md bg-error/10 px-3 py-2 text-[13px] text-error">
          Could not load the changelog: {error}
        </p>
      ) : markdown === null ? (
        <div className="flex flex-col gap-2 py-2" aria-busy="true">
          <span className="sr-only">Loading changelog…</span>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className={`h-4 animate-pulse rounded bg-hover ${i % 2 ? "w-2/3" : "w-full"}`} />
          ))}
        </div>
      ) : markdown ? (
        <MarkdownRenderer
          content={markdown}
          className="text-sm prose-h2:mt-7 prose-h2:mb-2 prose-h2:text-base prose-h3:mt-4 prose-h3:mb-1 prose-h3:text-[13px] prose-h3:font-semibold prose-h3:text-base-content/60 prose-li:my-0.5"
        />
      ) : (
        <p className="py-8 text-center text-sm text-base-content/60">No changelog available.</p>
      )}
    </Modal>
  );
}

export function PlaudModal({
  status,
  onClose,
  onRefreshStatus
}: {
  status: PlaudStatus | null;
  onClose: () => void;
  onRefreshStatus: () => void;
}): ReactElement {
  const [syncing, setSyncing] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const connected = !!status?.connected;

  const handleTriggerSync = async () => {
    setSyncing(true);
    try {
      const res = await fetch("/api/plaud/sync/trigger", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      notify(
        "success",
        data.alreadyRunning
          ? "A Plaud sync is already running in the background."
          : "Plaud sync started in the background. New recordings will appear as they finish."
      );
      onRefreshStatus();
    } catch (err) {
      notify("error", `Sync failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <Modal
      onClose={onClose}
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span>Plaud</span>
          <span className={`tag text-xs ${connected ? "tag-green" : "tag-yellow"}`}>{connected ? "Connected" : "Not connected"}</span>
        </span>
      }
      ariaLabel="Plaud integration"
      maxWidth="max-w-lg"
      footer={
        connected && !reconnecting ? (
          <ModalFooter>
            <Button variant="ghost" onClick={() => setReconnecting(true)}>
              Re-authenticate
            </Button>
            <Button variant="primary" disabled={syncing} onClick={() => void handleTriggerSync()}>
              <RefreshCw className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`} aria-hidden="true" />
              {syncing ? "Starting sync…" : "Sync now"}
            </Button>
          </ModalFooter>
        ) : undefined
      }
    >
      {connected && !reconnecting ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-[13px]">
          <dt className="text-base-content/60">Status</dt>
          <dd>Signed in, tokens refresh automatically</dd>
          <dt className="text-base-content/60">Last sync</dt>
          <dd>{status?.lastPollAt ? formatDate(status.lastPollAt) : "Never"}</dd>
          <dt className="text-base-content/60">Waiting to import</dt>
          <dd>{status?.pcsPending ?? 0}</dd>
        </dl>
      ) : (
        <>
          <p className="text-base-content/75">
            Connect your Plaud account to import recordings, transcripts and summaries into Olive automatically.
          </p>
          <PlaudConnect autoStart={reconnecting} onConnected={onRefreshStatus} onCancel={() => setReconnecting(false)} onDone={onClose} />
        </>
      )}
    </Modal>
  );
}
