import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { X } from "lucide-react";
import { AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, useLocalRuntime, type ChatModelAdapter, type ThreadMessageLike } from "@assistant-ui/react";
import { confirmAction, notify } from "../components/ui";
import type { ChatMessage } from "../api/types.ts";

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

export function MeetingChatPanel({ meetingId, meetingTitle, onClose }: { meetingId: string; meetingTitle: string; onClose: () => void }): ReactElement {
  const [initialMessages, setInitialMessages] = useState<readonly ThreadMessageLike[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <aside className="flex h-full w-full max-w-xl flex-col bg-base-100" role="dialog" aria-modal="true" aria-label={`Chat with ${meetingTitle}`}>
      <div className="flex items-center justify-between border-b border-base-300 bg-base-200 px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wider text-primary">Chat with Meeting</p>
          <h2 className="truncate text-sm font-medium">{meetingTitle}</h2>
        </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={async () => {
                if (!(await confirmAction({ title: "Clear chat history", message: "Clear this meeting's chat history?", confirmLabel: "Clear", danger: true }))) return;
                void fetch(`/api/meetings/${meetingId}/chat/messages`, { method: "DELETE" }).then((response) => {
                  if (!response.ok) throw new Error("Failed to clear chat history");
                  onClose();
                }).catch((error) => notify("error", error instanceof Error ? error.message : String(error)));
              }}
              className="btn btn-ghost btn-sm min-h-[44px]"
            >
              Clear
            </button>
            <button type="button" onClick={onClose} className="btn btn-ghost inline-flex min-h-[44px] min-w-[44px] items-center justify-center text-lg leading-none hover:text-white" aria-label="Close chat"><X className="h-4 w-4 shrink-0" aria-hidden="true" /></button>
          </div>
        </div>

        {loading ? <div className="flex flex-1 items-center justify-center text-sm text-base-content/50">Loading conversation…</div> : loadError ? <div className="m-4 alert alert-soft alert-error p-3 text-sm">{loadError}</div> : initialMessages ? (
          <MeetingChatRuntime
            meetingId={meetingId}
            initialMessages={initialMessages}
          />
        ) : null}
      </aside>
  );
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
        <ThreadPrimitive.Viewport autoScroll className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <ThreadPrimitive.Messages components={{
            UserMessage: () => (
              <MessagePrimitive.Root className="mb-4 flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2.5 text-sm text-primary-content">
                  <MessagePrimitive.Content />
                </div>
              </MessagePrimitive.Root>
            ),
            AssistantMessage: () => (
              <MessagePrimitive.Root className="mb-4 flex justify-start">
                <div className="max-w-[90%] rounded-2xl rounded-bl-md border border-base-300 bg-base-200 px-3.5 py-2.5 text-sm text-base-content prose prose-invert prose-sm max-w-none">
                  <MessagePrimitive.Content />
                </div>
              </MessagePrimitive.Root>
            )
          }} />
        </ThreadPrimitive.Viewport>
        <div className="border-t border-base-300 bg-base-200/80 pb-safe">
          <ComposerPrimitive.Root className="p-3">
            <ComposerPrimitive.Input placeholder="Ask about this meeting…" className="min-h-20 w-full resize-none rounded-xl border border-base-300 bg-base-100 px-3 py-2 text-base text-base-content outline-none placeholder:text-base-content/50 focus:border-primary sm:text-sm" />
            <div className="mt-2 flex justify-end">
              <ComposerPrimitive.Send className="btn btn-primary min-h-[44px] text-sm disabled:cursor-not-allowed">Send</ComposerPrimitive.Send>
            </div>
          </ComposerPrimitive.Root>
        </div>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
