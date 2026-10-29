import { useState } from "react";
import type { ReactElement } from "react";
import { RefreshCw } from "lucide-react";
import { Button, notify } from "../../components/ui";
import { formatDate, type PlaudStatus } from "../../lib/common";
import { PlaudConnect } from "./PlaudConnect";
import { CopyField, INPUT_CLASS, Panel, SectionHeader, StatusTag, errorText, readError, type AppConfigDto } from "./shared";

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return formatDate(ts);
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  return formatDate(ts);
}

export function pollIntervalError(value: number): string | null {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) return "Enter a whole number of minutes (1 or more).";
  if (value > 1440) return "Use 1440 minutes (one day) or less.";
  return null;
}

function PlaudCard({
  status,
  onRefreshStatus,
  draft,
  onChange,
}: {
  status: PlaudStatus | null;
  onRefreshStatus: () => void;
  draft: AppConfigDto;
  onChange: <K extends keyof AppConfigDto>(key: K, value: AppConfigDto[K]) => void;
}): ReactElement {
  const [syncing, setSyncing] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [pollText, setPollText] = useState(String(draft.pollIntervalMinutes));
  const connected = !!status?.connected;

  // Keep the text box in sync when the draft is reset (Discard / after save).
  const [lastDraftPoll, setLastDraftPoll] = useState(draft.pollIntervalMinutes);
  if (lastDraftPoll !== draft.pollIntervalMinutes) {
    setLastDraftPoll(draft.pollIntervalMinutes);
    if (Number(pollText) !== draft.pollIntervalMinutes) setPollText(String(draft.pollIntervalMinutes));
  }
  const pollError = pollIntervalError(draft.pollIntervalMinutes);

  const sync = async () => {
    setSyncing(true);
    try {
      const res = await fetch("/api/plaud/sync/trigger", { method: "POST" });
      if (!res.ok) throw new Error(await readError(res, "Sync failed"));
      const data = (await res.json()) as { alreadyRunning?: boolean };
      notify("success", data.alreadyRunning ? "A Plaud sync is already running." : "Plaud sync started. New recordings appear as they finish.");
      onRefreshStatus();
    } catch (err) {
      notify("error", `Sync failed: ${errorText(err)}`);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-2.5">
        <h3 className="flex-1 text-base font-semibold">Plaud</h3>
        {status === null ? (
          <StatusTag tone="gray">Checking…</StatusTag>
        ) : connected ? (
          <StatusTag tone="green">Connected</StatusTag>
        ) : (
          <StatusTag tone="yellow">Not connected</StatusTag>
        )}
      </div>
      <p className="text-[13px] text-base-content/65">
        Imports new recordings, transcripts and summaries from your Plaud account.
        {connected && (
          <>
            {" "}
            Last sync {status?.lastPollAt ? <span title={formatDate(status.lastPollAt)}>{timeAgo(status.lastPollAt)}</span> : "never"} ·{" "}
            {status?.pcsPending ?? 0} waiting.
          </>
        )}
      </p>

      {connected && !reconnecting && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => void sync()} disabled={syncing}>
            <RefreshCw className={`h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} aria-hidden="true" />
            {syncing ? "Starting sync…" : "Sync now"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setReconnecting(true)}>
            Re-authenticate
          </Button>
        </div>
      )}
      {(!connected || reconnecting) && status !== null && (
        <PlaudConnect
          autoStart={reconnecting}
          onConnected={onRefreshStatus}
          onCancel={() => setReconnecting(false)}
          onDone={() => setReconnecting(false)}
        />
      )}

      <div className="flex flex-col gap-1 border-t border-divider pt-3">
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <label htmlFor="plaud-poll" className="font-medium">
            Check for new recordings every
          </label>
          <input
            id="plaud-poll"
            type="number"
            inputMode="numeric"
            min={1}
            max={1440}
            step={1}
            value={pollText}
            onChange={(e) => {
              setPollText(e.target.value);
              onChange("pollIntervalMinutes", e.target.value.trim() === "" ? Number.NaN : Number(e.target.value));
            }}
            aria-invalid={!!pollError}
            aria-describedby="plaud-poll-hint"
            className={`${INPUT_CLASS} w-20! ${pollError ? "border-error!" : ""}`}
          />
          <span>minutes</span>
        </div>
        {pollError ? (
          <span id="plaud-poll-hint" role="alert" className="text-xs text-error">
            {pollError}
          </span>
        ) : (
          <span id="plaud-poll-hint" className="text-xs text-base-content/60">
            Applies after Olive restarts. Use Sync now to check right away.
          </span>
        )}
      </div>
    </Panel>
  );
}

export function IntegrationsSection({
  plaudStatus,
  onRefreshPlaud,
  draft,
  onChange,
}: {
  plaudStatus: PlaudStatus | null;
  onRefreshPlaud: () => void;
  draft: AppConfigDto;
  onChange: <K extends keyof AppConfigDto>(key: K, value: AppConfigDto[K]) => void;
}): ReactElement {
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  return (
    <section aria-labelledby="settings-integrations">
      <SectionHeader id="settings-integrations" title="Integrations" description="Where recordings come from and which apps can read them." />
      <div className="flex flex-col gap-3">
        <PlaudCard status={plaudStatus} onRefreshStatus={onRefreshPlaud} draft={draft} onChange={onChange} />

        <Panel>
          <h3 className="text-base font-semibold">MCP server</h3>
          <p className="text-[13px] text-base-content/65">
            Lets Claude and other MCP clients search meetings and read transcripts and summaries.
          </p>
          <CopyField value={`${origin}/mcp`} label="MCP URL" />
          <p className="text-xs text-base-content/60">
            Read tools are always available. Edit tools (rename, tag, re-summarize) are turned on on the server with{" "}
            <code className="font-mono">OLIVE_MCP_WRITE=1</code>. When <code className="font-mono">OLIVE_MCP_TOKEN</code> or{" "}
            <code className="font-mono">OLIVE_INGEST_TOKEN</code> is set, clients send it as a Bearer token.
          </p>
        </Panel>

        <Panel>
          <h3 className="text-base font-semibold">iOS Shortcut</h3>
          <p className="text-[13px] text-base-content/65">Send voice memos from your phone straight into Olive. The Shortcut posts the audio file to this address.</p>
          <CopyField value={`${origin}/api/ingest`} label="Ingest URL" />
          <p className="text-xs text-base-content/60">
            When <code className="font-mono">OLIVE_INGEST_TOKEN</code> is set on the server, add it to the Shortcut as an{" "}
            <code className="font-mono">Authorization: Bearer</code> header.
          </p>
        </Panel>
      </div>
    </section>
  );
}
