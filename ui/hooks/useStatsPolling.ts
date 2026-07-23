import { useCallback, useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { StatsResponse } from "../types";
import type { ApiFn } from "./useApi";

/** stats 改手动刷新(原 2s 自动轮询取消——stats 是诊断用非核心,用户嫌频繁)。
 *  启动拉一次(初始状态) + 返回 refresh 函数供 Header 刷新按钮手动调。 */
export function useStatsPolling(api: ApiFn, setStats: Dispatch<SetStateAction<StatsResponse | null>>): () => void {
  const refresh = useCallback(async () => {
    try {
      setStats(await api<StatsResponse>("/api/stats"));
    } catch (e) {
      console.warn("stats refresh", e);
    }
  }, [api, setStats]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return refresh;
}
