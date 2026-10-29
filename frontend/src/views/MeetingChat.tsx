import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { ArrowUp, Copy, Square, X } from "lucide-react";
import { ActionBarPrimitive, AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, useLocalRuntime, type ChatModelAdapter, type ThreadMessageLike } from "@assistant-ui/react";
import { confirmAction, notify } from "../components/ui";
import type { ChatMessage } from "../api/types.ts";
import { MarkdownRenderer } from "../lib/common";

export function chatMessageContent(message: ChatMessage): ThreadMessageLike {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: new Date(message.createdAt)
  };
}

export function chatTextFromMessage(message: { content: unknown }): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part): part is { type: "text"; text: string } =>
      typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string"
    )
    .map((part) => part.text)
    .join("");
}

export function parseChatStreamBlock(block: string): { event: string; data: string } | null {
  let event = "message";
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  return data ? { event, data } : null;
}

export function ChatTitleReporter({ title, onChatTitle }: { title: string; onChatTitle: (title: string) => void }): ReactElement | null {
  useEffect(() => {
    onChatTitle(title);
  }, [title, onChatTitle]);
  return null;
}

/** Prompts offered above the composer; clicking one sends it right away. */
export const CHAT_SUGGESTIONS = [
  "Draft a follow-up email",
  "List the decisions",
  "What are the action items and owners?",
  "What questions are still open?"
];

/** Loads this meeting's chat history; `reset` starts over with an empty thread. */
function useChatHistory(meetingId: string): {
  initialMessages: readonly ThreadMessageLike[] | null;
  loading: boolean;
  loadError: string | null;
  version: number;
  reset: () => void;
} {
  const [initialMessages, setInitialMessages] = useState<readonly ThreadMessageLike[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void fetch(`/api/meetings/${meetingId}/chat/messages`)
      .then(async (response) => {
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `HTTP ${response.status}`);
        return response.json() as Promise<{ messages: ChatMessage[] }>;
      })
      .then((data) => {
        if (!cancelled) setInitialMessages(data.messages.map(chatMessageContent));
      })
      .catch((error) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [meetingId]);

  const reset = useCallback(() => {
    setInitialMessages([]);
    setVersion((v) => v + 1);
  }, []);

  return { initialMessages, loading, loadError, version, reset };
}

async function clearChatHistory(meetingId: string): Promise<boolean> {
  if (!(await confirmAction({ title: "Start a new chat", message: "This clears this meeting's chat history.", confirmLabel: "Clear history", danger: true }))) {
    return false;
  }
  try {
    const response = await fetch(`/api/meetings/${meetingId}/chat/messages`, { method: "DELETE" });
    if (!response.ok) throw new Error("Failed to clear chat history");
    return true;
  } catch (error) {
    notify("error", error instanceof Error ? error.message : String(error));
    return false;
  }
}

/** Drawer variant (App-level overlay). */
export function MeetingChatPanel({ meetingId, meetingTitle, onClose }: { meetingId: string; meetingTitle: string; onClose: () => void }): ReactElement {
  const { initialMessages, loading, loadError, version } = useChatHistory(meetingId);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <aside className="flex h-full w-full max-w-xl flex-col bg-base-100" role="dialog" aria-modal="true" aria-label={`Chat with ${meetingTitle}`}>
      <div className="flex items-center justify-between gap-2 border-b border-divider px-4 py-2.5">
        <div className="min-w-0">
          <h2 className="font-semibold">Chat</h2>
          <p className="truncate text-xs text-base-content/50">{meetingTitle}</p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={async () => {
              if (await clearChatHistory(meetingId)) onClose();
            }}
            className="btn btn-ghost btn-sm min-h-11"
          >
            New chat
          </button>
          <button type="button" onClick={onClose} className="btn btn-ghost btn-square min-h-11 min-w-11" aria-label="Close chat">
            <X className="h-4 w-4 shrink-0" aria-hidden="true" />
          </button>
        </div>
      </div>
      <ChatBody meetingId={meetingId} loading={loading} loadError={loadError} initialMessages={initialMessages} version={version} />
    </aside>
  );
}

/** Inline variant for the meeting side panel and the mobile Chat tab. */
export function MeetingChatInline({ meetingId, className = "" }: { meetingId: string; className?: string }): ReactElement {
  const { initialMessages, loading, loadError, version, reset } = useChatHistory(meetingId);

  return (
    <section aria-label="Chat with this meeting" className={`flex min-h-0 flex-col ${className}`}>
      <div className="flex items-center justify-between gap-2 px-4 pt-3 pb-1 lg:px-5">
        <h2 className="font-semibold">Chat</h2>
        <button
          type="button"
          onClick={async () => {
            if (await clearChatHistory(meetingId)) reset();
          }}
          className="btn btn-ghost btn-sm min-h-11 font-normal text-base-content/60 lg:min-h-0"
        >
          New chat
        </button>
      </div>
      <ChatBody meetingId={meetingId} loading={loading} loadError={loadError} initialMessages={initialMessages} version={version} />
    </section>
  );
}

function ChatBody({
  meetingId,
  loading,
  loadError,
  initialMessages,
  version
}: {
  meetingId: string;
  loading: boolean;
  loadError: string | null;
  initialMessages: readonly ThreadMessageLike[] | null;
  version: number;
}): ReactElement | null {
  if (loading) return <div className="flex flex-1 items-center justify-center text-sm text-base-content/50">Loading conversation…</div>;
  if (loadError) return <div className="m-4 rounded-lg bg-error/10 p-3 text-sm text-error">{loadError}</div>;
  if (!initialMessages) return null;
  return <MeetingChatRuntime key={version} meetingId={meetingId} initialMessages={initialMessages} />;
}

function AssistantText({ text }: { text: string }): ReactElement {
  return <MarkdownRenderer content={text} className="prose-sm" />;
}

export function MeetingChatRuntime({ meetingId, initialMessages }: { meetingId: string; initialMessages: readonly ThreadMessageLike[] }): ReactElement {
  const adapter: ChatModelAdapter = useMemo(() => ({
    async *run({ messages, abortSignal }) {
      const latest = messages[messages.length - 1];
      const content = latest ? chatTextFromMessage(latest) : "";
      const response = await fetch(`/api/meetings/${meetingId}/chat/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({ content }),
        signal: abortSignal
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(error.error || `HTTP ${response.status}`);
      }
      if (!response.body) throw new Error("Chat response did not include a stream");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fullText = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.replace(/\r\n/g, "\n").split("\n\n");
        buffer = blocks.pop() || "";
        for (const block of blocks) {
          const parsed = parseChatStreamBlock(block);
          if (!parsed) continue;
          const data = JSON.parse(parsed.data) as { delta?: string; error?: string };
          if (parsed.event === "error") throw new Error(data.error || "Chat request failed");
          if (parsed.event === "delta" && data.delta) {
            fullText += data.delta;
            yield { content: [{ type: "text", text: fullText }] };
          }
        }
      }
    }
  }), [meetingId]);

  const runtime = useLocalRuntime(adapter, { initialMessages });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
        <ThreadPrimitive.Viewport autoScroll className="min-h-0 flex-1 overflow-y-auto px-4 py-3 lg:px-5">
          <ThreadPrimitive.Empty>
            <p className="py-6 text-sm text-base-content/50">Ask anything about this meeting — who said what, decisions, follow-ups.</p>
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages components={{
            UserMessage: () => (
              <MessagePrimitive.Root className="mb-4 flex justify-end">
                <div className="max-w-[85%] whitespace-pre-wrap rounded-xl bg-active px-3 py-2 text-sm text-base-content">
                  <MessagePrimitive.Content />
                </div>
              </MessagePrimitive.Root>
            ),
            AssistantMessage: () => (
              <MessagePrimitive.Root className="mb-5 flex flex-col gap-1.5">
                <span className="flex items-center gap-1.5 text-xs text-base-content/50">
                  <span className="inline-flex h-[18px] w-[18px] items-center justify-center rounded-[5px] bg-primary text-[10px] font-bold text-primary-content">O</span>
                  Olive
                </span>
                <div className="min-w-0 text-sm">
                  <MessagePrimitive.Content components={{ Text: AssistantText }} />
                </div>
                <ActionBarPrimitive.Root hideWhenRunning autohide="not-last" className="flex gap-0.5">
                  <ActionBarPrimitive.Copy className="btn btn-ghost btn-xs min-h-9 gap-1 font-normal text-base-content/60 lg:min-h-0">
                    <Copy className="h-3.5 w-3.5" aria-hidden="true" /> Copy
                  </ActionBarPrimitive.Copy>
                </ActionBarPrimitive.Root>
              </MessagePrimitive.Root>
            )
          }} />
        </ThreadPrimitive.Viewport>
        <div className="space-y-2.5 px-4 pt-2 pb-4 lg:px-5">
          <div className="flex flex-wrap gap-1.5">
            {CHAT_SUGGESTIONS.map((prompt) => (
              <ThreadPrimitive.Suggestion
                key={prompt}
                prompt={prompt}
                send
                className="min-h-9 rounded-full border border-base-300 px-3 text-xs text-base-content/80 transition hover:bg-hover lg:min-h-7"
              >
                {prompt}
              </ThreadPrimitive.Suggestion>
            ))}
          </div>
          <ComposerPrimitive.Root className="flex flex-col gap-2 rounded-box border border-base-300 bg-base-100 px-3 py-2.5 focus-within:border-primary">
            <ComposerPrimitive.Input
              rows={2}
              placeholder="Ask about this meeting…"
              aria-label="Ask about this meeting"
              className="w-full resize-none bg-transparent text-base text-base-content outline-none placeholder:text-base-content/50 sm:text-sm"
            />
            <div className="flex items-center justify-end">
              <ThreadPrimitive.If running={false}>
                <ComposerPrimitive.Send aria-label="Send" className="btn btn-primary btn-square btn-sm min-h-9 min-w-9 disabled:cursor-not-allowed">
                  <ArrowUp className="h-4 w-4" aria-hidden="true" />
                </ComposerPrimitive.Send>
              </ThreadPrimitive.If>
              <ThreadPrimitive.If running>
                <ComposerPrimitive.Cancel aria-label="Stop" className="btn btn-square btn-sm min-h-9 min-w-9">
                  <Square className="h-3.5 w-3.5" aria-hidden="true" />
                </ComposerPrimitive.Cancel>
              </ThreadPrimitive.If>
            </div>
          </ComposerPrimitive.Root>
        </div>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
