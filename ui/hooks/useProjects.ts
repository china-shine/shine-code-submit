// L1 项目列表 + 全局 totals(/api/projects)。OverviewModule/会话/报表 L1 标头汇总用。
// reload():手动刷新(标头刷新按钮调),重新拉 /api/projects(后端 scanSessions 10s + git 5min 缓存命中,快)。
import { useCallback, useEffect, useState } from "react";
import type { ApiFn } from "./useApi";
import type { ProjectSummary, ProjectsResponse, ReportTotals } from "../types";

export function useProjects(api: ApiFn, active: boolean) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [totals, setTotals] = useState<ReportTotals | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadCount, setReloadCount] = useState(0);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const r: ProjectsResponse = await api("/api/projects?page=1&pageSize=500");
        if (!alive) return;
        setProjects(r.projects);
        setTotals(r.totals);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [api, active, reloadCount]);

  const reload = useCallback(() => setReloadCount((c) => c + 1), []);
  return { projects, totals, loading, error, reload };
}
