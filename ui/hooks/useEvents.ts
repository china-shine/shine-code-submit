import { useEffect, useRef, useState } from "react";
import type { EventsResponse, HookEvent } from "../types";
import type { ApiFn } from "./useApi";

/** 拉事件历史（/api/events）。active=true 才拉；sessionId=null 看全部、非 null 单会话。
 *  Step 3 下沉：返回自包含 {events, loading, error}，各模块自管实例，互不覆盖。
 *  loadedSessionRef：换 sessionId 先清空，避免闪现旧数据。 */
export function useEvents(api: ApiFn, sessionId: string | null, active: boolean) {
  const [events, setEvents] = useState<HookEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedSessionRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (!active) return;
    if (loadedSessionRef.current !== sessionId) {
      setEvents([]);
      loadedSessionRef.current = sessionId;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const qs = sessionId
          ? "?sessionId=" + encodeURIComponent(sessionId) + "&limit=200"
          : "?limit=200";
        const data = await api<EventsResponse>("/api/events" + qs);
        if (alive) {
          setEvents(data.events);
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

  return { events, loading, error };
}
