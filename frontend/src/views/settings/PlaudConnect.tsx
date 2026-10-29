import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import { Check, ExternalLink } from "lucide-react";
import { Button } from "../../components/ui";
import { INPUT_CLASS, errorText, readError } from "./shared";

/**
 * Plaud OAuth 2.0 PKCE connect flow: start → open Plaud login → paste the
 * callback URL → done. Shared by the Integrations settings and PlaudModal.
 */
export function PlaudConnect({
  onConnected,
  onCancel,
  onDone,
  autoStart = false,
}: {
  onConnected: () => void;
  onCancel?: () => void;
  onDone?: () => void;
  autoStart?: boolean;
}): ReactElement {
  const [step, setStep] = useState<"idle" | "authorizing" | "success">("idle");
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [callbackInput, setCallbackInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoStarted = useRef(false);

  const start = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/plaud/auth/start", { method: "POST" });
      if (!res.ok) throw new Error(await readError(res, "Could not start the Plaud login"));
      const data = (await res.json()) as { authUrl: string; sessionId: string };
      setAuthUrl(data.authUrl);
      setSessionId(data.sessionId);
      setCallbackInput("");
      setStep("authorizing");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!autoStart || autoStarted.current) return;
    autoStarted.current = true;
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart]);

  const complete = async (e: FormEvent) => {
    e.preventDefault();
    if (!sessionId) return;
    if (!callbackInput.trim()) {
      setError("Paste the callback URL or code from your browser.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/plaud/auth/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, pastedUrlOrCode: callbackInput.trim() }),
      });
      if (!res.ok) throw new Error(await readError(res, "Could not complete the Plaud login"));
      setStep("success");
      onConnected();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  };

  const errorBox = error && (
    <p role="alert" className="rounded-md bg-error/10 px-3 py-2 text-[13px] text-error">
      {error}
    </p>
  );

  if (step === "success") {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="flex items-center gap-2 font-medium">
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-[color:var(--tag-green-bg)] text-[color:var(--tag-green)]">
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
          Plaud connected
        </p>
        <p className="text-[13px] text-base-content/65">Tokens refresh automatically. New recordings appear after the next sync.</p>
        {onDone && (
          <Button variant="primary" size="sm" onClick={onDone}>
            Done
          </Button>
        )}
      </div>
    );
  }

  if (step === "authorizing" && authUrl) {
    return (
      <form onSubmit={(e) => void complete(e)} className="flex flex-col gap-4">
        {errorBox}
        <ol className="flex flex-col gap-4">
          <li className="flex gap-3">
            <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-hover text-xs font-semibold">1</span>
            <div className="flex min-w-0 flex-col items-start gap-2">
              <span className="font-medium">Sign in to Plaud</span>
              <span className="text-[13px] text-base-content/65">Opens the official Plaud login in a new tab. Sign in and allow access.</span>
              <a
                href={authUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-sm btn-primary rounded-md border-0 font-medium shadow-none max-sm:min-h-11"
              >
                Open Plaud login
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-hover text-xs font-semibold">2</span>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <label htmlFor="plaud-callback" className="font-medium">
                Paste the address you land on
              </label>
              <span className="text-[13px] text-base-content/65">
                Plaud sends you to an address starting with{" "}
                <code className="rounded bg-hover px-1 font-mono text-[12px] break-all">http://localhost:8199/auth/callback?code=…</code>. The page may say
                it can't be reached; that is expected. Copy the whole address from the address bar.
              </span>
              <input
                id="plaud-callback"
                type="text"
                required
                value={callbackInput}
                onChange={(e) => setCallbackInput(e.target.value)}
                placeholder="http://localhost:8199/auth/callback?code=…&state=…"
                autoComplete="off"
                spellCheck={false}
                className={`${INPUT_CLASS} font-mono`}
              />
            </div>
          </li>
        </ol>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setStep("idle");
              setError(null);
              onCancel?.();
            }}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="sm" disabled={loading || !callbackInput.trim()}>
            {loading ? "Verifying…" : "Complete connection"}
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="flex flex-col items-start gap-3">
      {errorBox}
      <Button variant="primary" size="sm" disabled={loading} onClick={() => void start()}>
        {loading ? "Generating login link…" : "Connect Plaud"}
      </Button>
    </div>
  );
}
