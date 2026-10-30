import { useCallback, useEffect, useState } from "react";
import type { ReactElement } from "react";
import { ChevronDown } from "lucide-react";
import { Button, confirmAction, notify } from "../../components/ui";
import type { LlmProviderSummary } from "../../api/types.ts";
import { OAuthPasteConnect } from "./OAuthPasteConnect";
import { StatusTag, errorText, readError } from "./shared";

/** GET /api/llm/<chatgpt-plan|chatgpt-codex>/status */
interface ChatGptPlanStatus {
  connected: boolean;
  email: string | null;
  /** Plan sign-in only: whether the user allowed plan usage. */
  planEnabled?: boolean;
  /** Codex sign-in only: the ChatGPT plan, e.g. "plus" or "enterprise". */
  planType?: string | null;
}

/** How each ChatGPT sign-in differs: its API routes and the copy around them. */
interface ChatGptSignIn {
  apiBase: string;
  callbackPrefix: string;
  signInHint: string;
  idleMeta: string;
  inputId: string;
}

const SIGN_INS: Record<string, ChatGptSignIn> = {
  "chatgpt-plan": {
    apiBase: "/api/llm/chatgpt-plan",
    callbackPrefix: "http://127.0.0.1:1455/auth/callback",
    signInHint: "Opens the official ChatGPT sign-in in a new tab. Sign in and allow Olive to use your ChatGPT plan.",
    idleMeta: "Uses your ChatGPT Go, Plus or Pro plan instead of an API key",
    inputId: "chatgpt-plan-callback",
  },
  "chatgpt-codex": {
    apiBase: "/api/llm/chatgpt-codex",
    callbackPrefix: "http://localhost:1455/auth/callback",
    signInHint: "Opens the ChatGPT sign-in for Codex in a new tab. Unofficial: use it when the sign-in above is blocked, for example in Enterprise workspaces that allow Codex.",
    idleMeta: "Signs in like the Codex CLI · works where Codex is allowed · unofficial",
    inputId: "chatgpt-codex-callback",
  },
};

/** Providers list row for a ChatGPT account provider: sign in instead of an API key. */
export function ChatGptPlanRow({ provider, onChanged }: { provider: LlmProviderSummary; onChanged: () => Promise<void> }): ReactElement {
  const signIn = SIGN_INS[provider.id] ?? SIGN_INS["chatgpt-plan"];
  const [status, setStatus] = useState<ChatGptPlanStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch(`${signIn.apiBase}/status`);
      if (res.ok) setStatus((await res.json()) as ChatGptPlanStatus);
    } catch {
      // the row falls back to the provider summary
    }
  }, [signIn.apiBase]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const disconnect = async () => {
    if (!(await confirmAction({ title: "Disconnect ChatGPT?", message: "Chat and summaries set to the ChatGPT plan will stop working until you connect again.", confirmLabel: "Disconnect", danger: true }))) return;
    setBusy(true);
    try {
      const res = await fetch(`${signIn.apiBase}/logout`, { method: "POST" });
      if (!res.ok) throw new Error(await readError(res, "Could not disconnect ChatGPT"));
      const data = (await res.json()) as { revoked?: boolean };
      if (!data.revoked && provider.id === "chatgpt-plan") notify("info", "Disconnected here. Also remove Olive under ChatGPT → Settings to revoke its access.");
      await Promise.all([loadStatus(), onChanged()]);
    } catch (err) {
      notify("error", errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const connected = status?.connected ?? provider.isConfigured;
  const ready = connected && (status?.planEnabled ?? provider.isConfigured);
  const meta = connected ? [status?.email, status?.planType, `${provider.modelCount} models`].filter(Boolean).join(" · ") : signIn.idleMeta;
  const panelId = `provider-${provider.id}`;

  return (
    <li className="border-b border-divider last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-3">
        <span className="flex min-w-0 flex-[1_1_12rem] flex-col">
          <span className="font-medium">{provider.name}</span>
          <span className="truncate text-xs text-base-content/60" title={meta}>
            {meta}
          </span>
        </span>
        {ready ? (
          <StatusTag tone="green">Ready</StatusTag>
        ) : connected ? (
          <StatusTag tone="yellow">Plan usage off</StatusTag>
        ) : (
          <StatusTag tone="yellow">Not connected</StatusTag>
        )}
        {connected && !open ? (
          <span className="flex gap-2">
            {!ready && (
              <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
                Reconnect
              </Button>
            )}
            <Button size="sm" variant="secondary" onClick={() => void disconnect()} disabled={busy}>
              {busy ? "Disconnecting…" : "Disconnect"}
            </Button>
          </span>
        ) : (
          <Button size="sm" variant="secondary" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((v) => !v)}>
            {open ? "Close" : "Connect"}
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
          </Button>
        )}
      </div>
      {open && (
        <div id={panelId} className="px-3.5 pb-4">
          <OAuthPasteConnect
            service="ChatGPT"
            startUrl={`${signIn.apiBase}/auth/start`}
            completeUrl={`${signIn.apiBase}/auth/complete`}
            signInHint={signIn.signInHint}
            callbackPrefix={signIn.callbackPrefix}
            successNote="Pick a ChatGPT plan model above for summaries or meeting chat. Usage counts against your plan's limits."
            inputId={signIn.inputId}
            autoStart
            onConnected={() => void Promise.all([loadStatus(), onChanged()])}
            onCancel={() => setOpen(false)}
            onDone={() => setOpen(false)}
          />
        </div>
      )}
    </li>
  );
}
