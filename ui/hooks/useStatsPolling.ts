import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { StatsResponse } from "../types";
import type { ApiFn } from "./useApi";

/** stats 每 2s 轮询（Header 状态条：spool backlog / event rate，cheap DB count + log tail）。启动拉一次。
 *  P3 起 sessions 不再全局轮询(改分级按需加载:会话/报表模块走 /api/projects + /api/sessions?cwd=)。 */
export function useStatsPolling(api: ApiFn, setStats: Dispatch<SetStateAction<StatsResponse | null>>): void {
  useEffect(() => {
    let alive = true;
    const refreshStats = async () => {
      try {
        const s = await api<StatsResponse>("/api/stats");
        if (alive) setStats(s);
      } catch (e) {
        console.warn("stats refresh", e);
      }
    };
    void refreshStats();
    const statsId = setInterval(refreshStats, 2000);
    return () => {
      alive = false;
      clearInterval(statsId);
    };
  }, [api, setStats]);
}
