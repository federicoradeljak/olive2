import { useCallback, useEffect, useState } from "react";
import type { DebugQueuesSnapshot } from "../DebugQueues";

export interface QueueFeed {
  snapshot: DebugQueuesSnapshot | null;
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

/* Polls /api/debug/queues every `intervalMs` while not paused and the tab is
   visible. A manual refresh always fetches. */
export function useQueueFeed(intervalMs: number, paused: boolean): QueueFeed {
  const [snapshot, setSnapshot] = useState<DebugQueuesSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/debug/queues");
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setSnapshot((await res.json()) as DebugQueuesSnapshot);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    if (paused) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [refresh, paused, intervalMs]);

  return { snapshot, error, loading, refresh };
}
