import { useCallback, useEffect, useState } from "react";
import type { ReactElement } from "react";
import { ChevronDown } from "lucide-react";
import { Button, confirmAction, notify } from "../../components/ui";
import type { LlmProviderSummary } from "../../api/types.ts";
import { OAuthPasteConnect } from "./OAuthPasteConnect";
import { StatusTag, errorText, readError } from "./shared";

/** GET /api/llm/chatgpt-plan/status */
interface ChatGptPlanStatus {
  connected: boolean;
  email: string | null;
  planEnabled: boolean;
}

/** Providers list row for the ChatGPT plan: sign in instead of an API key. */
export function ChatGptPlanRow({ provider, onChanged }: { provider: LlmProviderSummary; onChanged: () => Promise<void> }): ReactElement {
  const [status, setStatus] = useState<ChatGptPlanStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/llm/chatgpt-plan/status");
      if (res.ok) setStatus((await res.json()) as ChatGptPlanStatus);
    } catch {
      // the row falls back to the provider summary
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const disconnect = async () => {
    if (!(await confirmAction({ title: "Disconnect ChatGPT?", message: "Chat and summaries set to the ChatGPT plan will stop working until you connect again.", confirmLabel: "Disconnect", danger: true }))) return;
    setBusy(true);
    try {
      const res = await fetch("/api/llm/chatgpt-plan/logout", { method: "POST" });
      if (!res.ok) throw new Error(await readError(res, "Could not disconnect ChatGPT"));
      const data = (await res.json()) as { revoked?: boolean };
      if (!data.revoked) notify("info", "Disconnected here. Also remove Olive under ChatGPT → Settings to revoke its access.");
      await Promise.all([loadStatus(), onChanged()]);
    } catch (err) {
      notify("error", errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const connected = status?.connected ?? provider.isConfigured;
  const ready = connected && (status?.planEnabled ?? provider.isConfigured);
  const meta = connected
    ? [status?.email, `${provider.modelCount} models`].filter(Boolean).join(" · ")
    : "Uses your ChatGPT Go, Plus or Pro plan instead of an API key";
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
            startUrl="/api/llm/chatgpt-plan/auth/start"
            completeUrl="/api/llm/chatgpt-plan/auth/complete"
            signInHint="Opens the official ChatGPT sign-in in a new tab. Sign in and allow Olive to use your ChatGPT plan."
            callbackPrefix="http://127.0.0.1:1455/auth/callback"
            successNote="Pick a ChatGPT plan model above for summaries or meeting chat. Usage counts against your plan's limits."
            inputId="chatgpt-plan-callback"
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
