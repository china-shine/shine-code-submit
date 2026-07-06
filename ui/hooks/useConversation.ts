import { useEffect, useRef, useState } from "react";
import type { TranscriptMessage, TranscriptResponse } from "../types";
import type { ApiFn } from "./useApi";

/** 拉某会话 transcript（/api/transcript）。active=true 且 sessionId 存在才拉。
 *  Step 3 下沉：返回自包含 {messages, loading, error}。loadedSidRef 换会话先清空防闪。 */
export function useConversation(api: ApiFn, sessionId: string | null, active: boolean) {
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedSidRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (!active || !sessionId) return;
    if (loadedSidRef.current !== sessionId) {
      setMessages([]);
      loadedSidRef.current = sessionId;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const data = await api<TranscriptResponse>(
          "/api/transcript?sessionId=" + encodeURIComponent(sessionId),
        );
        if (alive) {
          setMessages(data.messages);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [api, sessionId, active]);

  return { messages, loading, error };
}
