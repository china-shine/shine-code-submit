import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { SessionSummary, StatsResponse } from "../types";
import type { ApiFn } from "./useApi";

/** 每 2s 轮询 /api/stats + /api/sessions（启动即一次）。 */
export function useStatsPolling(
  api: ApiFn,
  setStats: Dispatch<SetStateAction<StatsResponse | null>>,
  setSessions: Dispatch<SetStateAction<SessionSummary[]>>,
): void {
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const [s, sess] = await Promise.all([
          api<StatsResponse>("/api/stats"),
          api<{ sessions: SessionSummary[] }>("/api/sessions"),
        ]);
        if (alive) {
          setStats(s);
          setSessions(sess.sessions);
        }
      } catch (e) {
        console.warn("refresh", e);
      }
    };
    void refresh();
    const id = setInterval(refresh, 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [api, setStats, setSessions]);
}
