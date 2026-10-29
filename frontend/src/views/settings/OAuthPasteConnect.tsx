import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import { Check, ExternalLink } from "lucide-react";
import { Button } from "../../components/ui";
import { INPUT_CLASS, errorText, readError } from "./shared";

/**
 * OAuth PKCE connect flow for logins whose callback cannot reach the server:
 * start → open the provider's sign-in → paste the callback URL → done.
 * Used by the Plaud and ChatGPT plan connections.
 */
export function OAuthPasteConnect({
  service,
  startUrl,
  completeUrl,
  signInHint,
  callbackPrefix,
  successNote,
  inputId,
  onConnected,
  onCancel,
  onDone,
  autoStart = false,
}: {
  /** Display name, e.g. "Plaud". */
  service: string;
  startUrl: string;
  completeUrl: string;
  signInHint: string;
  /** Start of the address the browser lands on, e.g. "http://localhost:8199/auth/callback". */
  callbackPrefix: string;
  successNote: string;
  inputId: string;
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
      const res = await fetch(startUrl, { method: "POST" });
      if (!res.ok) throw new Error(await readError(res, `Could not start the ${service} login`));
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
      const res = await fetch(completeUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, pastedUrlOrCode: callbackInput.trim() }),
      });
      if (!res.ok) throw new Error(await readError(res, `Could not complete the ${service} login`));
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
          {service} connected
        </p>
        <p className="text-[13px] text-base-content/65">{successNote}</p>
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
              <span className="font-medium">Sign in to {service}</span>
              <span className="text-[13px] text-base-content/65">{signInHint}</span>
              <a
                href={authUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-sm btn-primary rounded-md border-0 font-medium shadow-none max-sm:min-h-11"
              >
                Open {service} login
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-hover text-xs font-semibold">2</span>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <label htmlFor={inputId} className="font-medium">
                Paste the address you land on
              </label>
              <span className="text-[13px] text-base-content/65">
                {service} sends you to an address starting with{" "}
                <code className="rounded bg-hover px-1 font-mono text-[12px] break-all">{callbackPrefix}?code=…</code>. The page may say it can't be
                reached; that is expected. Copy the whole address from the address bar.
              </span>
              <input
                id={inputId}
                type="text"
                required
                value={callbackInput}
                onChange={(e) => setCallbackInput(e.target.value)}
                placeholder={`${callbackPrefix}?code=…&state=…`}
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
        {loading ? "Generating login link…" : `Connect ${service}`}
      </Button>
    </div>
  );
}
