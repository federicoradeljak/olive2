import React, { useEffect, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { Check } from "lucide-react";
import { Modal as UiModal, notify } from "../components/ui";
import { PlaudStatus, formatDate, MarkdownRenderer } from "../lib/common";

export function Modal({
  onClose,
  title,
  ariaLabel,
  maxWidth = "max-w-lg",
  children
}: {
  onClose: () => void;
  title: ReactNode;
  ariaLabel: string;
  maxWidth?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <UiModal onClose={onClose} title={title} ariaLabel={ariaLabel} maxWidth={maxWidth}>
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
      title={version ? `What's New — ${version}` : "What's New"}
      ariaLabel="Olive changelog"
      maxWidth="max-w-2xl"
    >
      {error ? (
        <div className="alert alert-soft alert-error p-3 text-sm text-error">
          Failed to load changelog: {error}
        </div>
      ) : markdown === null ? (
        <div className="py-8 text-center text-sm text-base-content/50">Loading changelog…</div>
      ) : markdown ? (
        <div className="max-h-[60vh] overflow-y-auto pr-1">
          <MarkdownRenderer content={markdown} />
        </div>
      ) : (
        <div className="py-8 text-center text-sm text-base-content/50">No changelog available.</div>
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
  const [authStep, setAuthStep] = useState<"idle" | "authorizing" | "success" | "error">("idle");
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [callbackInput, setCallbackInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  const handleStartAuth = async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const res = await fetch("/api/plaud/auth/start", { method: "POST" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { authUrl: string; sessionId: string };
      setAuthUrl(data.authUrl);
      setSessionId(data.sessionId);
      setAuthStep("authorizing");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleCompleteAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sessionId || !callbackInput.trim()) {
      notify("warning", "Please paste the callback URL or code from your browser");
      return;
    }

    setLoading(true);
    setErrorMessage(null);
    try {
      const res = await fetch("/api/plaud/auth/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId,
          pastedUrlOrCode: callbackInput.trim()
        })
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      setAuthStep("success");
      onRefreshStatus();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleTriggerSync = async () => {
    setSyncing(true);
    setSyncMessage(null);
    try {
      const res = await fetch("/api/plaud/sync/trigger", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setSyncMessage(
        data.alreadyRunning
          ? "A Plaud sync is already running in the background."
          : "Plaud sync started in the background. New recordings will appear as they finish."
      );
      onRefreshStatus();
    } catch (err) {
      setSyncMessage(`Sync failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <Modal onClose={onClose} title={<span className="flex flex-wrap items-center gap-2"><span>Plaud Integration</span><span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${status?.connected ? "bg-primary/10 text-primary" : "bg-warning/10 text-warning"}`}>{status?.connected ? "Connected" : "Disconnected"}</span></span>} ariaLabel="Plaud integration" maxWidth="max-w-lg">
      {errorMessage && (
        <div className="rounded-xl border border-error bg-error/10 p-4 text-xs text-error">
          {errorMessage}
        </div>
      )}

      {syncMessage && (
        <div className="rounded-xl border border-primary bg-primary/10 p-4 text-xs text-primary">
          {syncMessage}
        </div>
      )}

      {status?.connected && authStep === "idle" ? (
        <div className="space-y-4">
          <div className="rounded-xl border border-base-300 bg-base-100/60 p-4 space-y-2 text-xs text-base-content">
            <div className="flex justify-between">
              <span className="text-base-content/70">Connection Status:</span>
              <span className="font-semibold text-primary">Active (OAuth tokens valid)</span>
            </div>
            <div className="flex justify-between">
              <span className="text-base-content/70">Last Synced:</span>
              <span>{status.lastPollAt ? formatDate(status.lastPollAt) : "Never"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-base-content/70">Pending PCS Items:</span>
              <span>{status.pcsPending}</span>
            </div>
          </div>

          <div className="flex gap-3">
            <button
              type="button"
              disabled={syncing}
              onClick={() => void handleTriggerSync()}
              className="btn btn-primary flex-1 min-h-11"
            >
              {syncing ? "Syncing with Plaud…" : "Sync Now"}
            </button>
            <button
              type="button"
              onClick={() => void handleStartAuth()}
              className="btn bg-base-300 min-h-11"
            >
              Re-authenticate
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          {authStep === "idle" && (
            <div className="space-y-4 text-sm text-base-content">
              <p>
                Connect your Plaud account using OAuth 2.0 PKCE to automatically ingest recordings, transcripts, and summaries into Olive.
              </p>
              <button
                type="button"
                disabled={loading}
                onClick={() => void handleStartAuth()}
                className="btn btn-primary w-full py-2.5 min-h-11"
              >
                {loading ? "Generating login link…" : "Start Plaud OAuth Login"}
              </button>
            </div>
          )}

          {authStep === "authorizing" && authUrl && (
            <form onSubmit={handleCompleteAuth} className="space-y-4 text-sm">
              <div className="rounded-xl border border-base-300 bg-base-100/80 p-4 space-y-3">
                <p className="font-semibold text-base-content">Step 1: Authorize with Plaud</p>
                <p className="text-xs text-base-content/70 leading-relaxed">
                  Click the button below to open the official Plaud login in a new tab. Log in and grant permission.
                </p>
                <a
                  href={authUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-primary btn-sm min-h-11"
                >
                  Open Plaud Login Page ↗
                </a>
              </div>

              <div className="rounded-xl border border-base-300 bg-base-100/80 p-4 space-y-3">
                <p className="font-semibold text-base-content">Step 2: Paste the Callback URL</p>
                <p className="text-xs text-base-content/70 leading-relaxed">
                  After authorizing, Plaud will redirect your browser to a callback address starting with{" "}
                  <code className="rounded bg-base-200 px-1 py-0.5 text-primary">http://localhost:8199/auth/callback?code=...</code>{" "}
                  (your browser might show "Site can't be reached"—this is normal). Copy the <strong>entire URL</strong> from your address bar and paste it below:
                </p>
                <input
                  type="text"
                  required
                  placeholder="http://localhost:8199/auth/callback?code=...&state=..."
                  value={callbackInput}
                  onChange={(e) => setCallbackInput(e.target.value)}
                  className="input input-md w-full"
                />
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setAuthStep("idle")}
                  className="rounded-lg px-4 py-2 text-sm text-base-content/70 hover:text-base-content"
                >
                  Back
                </button>
                <button
                  type="submit"
                  disabled={loading || !callbackInput.trim()}
                  className="btn btn-primary min-h-11"
                >
                  {loading ? "Verifying…" : "Complete Connection"}
                </button>
              </div>
            </form>
          )}

          {authStep === "success" && (
            <div className="space-y-4 py-4 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/20 text-2xl text-primary">
                <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
              </div>
              <h4 className="text-lg font-bold text-base-content">Plaud Connected Successfully!</h4>
              <p className="text-xs text-base-content/70">
                Olive is now authenticated with your Plaud account. Tokens will refresh automatically.
              </p>
              <button
                type="button"
                onClick={() => {
                  setAuthStep("idle");
                  onClose();
                }}
                className="btn btn-primary min-h-11"
              >
                Done
              </button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
