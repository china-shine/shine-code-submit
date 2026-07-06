import { useEffect, useRef, useState } from "react";
import type { CommitLog, CommitsResponse, SessionSummary } from "../types";
import type { ApiFn } from "./useApi";

/** 跨所有 cwd 合并 git log（概览/统计模块用）。
 *  从 sessions 提取 distinct cwd，各拉 /api/commits，按 time 倒序合并。
 *  cwd 集合不变不重拉（sig 缓存，避 sessions 2s 轮询抖动）。 */
export interface AllCommit extends CommitLog {
  cwd: string;
}

export function useAllCommits(api: ApiFn, sessions: SessionSummary[], active: boolean) {
  const [commits, setCommits] = useState<AllCommit[]>([]);
  const [loading, setLoading] = useState(false);
  const loadedSigRef = useRef("");

  useEffect(() => {
    if (!active) return;
    const cwds = Array.from(new Set(sessions.map((s) => s.cwd).filter(Boolean)));
    const sig = cwds.join("\n");
    if (loadedSigRef.current === sig) return;
    loadedSigRef.current = sig;
    if (cwds.length === 0) {
      setCommits([]);
      return;
    }
    let alive = true;
    setLoading(true);
    void (async () => {
      try {
        const results = await Promise.all(
          cwds.map(async (cwd) => {
            try {
              const r = await api<CommitsResponse>(
                `/api/commits?cwd=${encodeURIComponent(cwd)}&limit=200`,
              );
              return { cwd, commits: r.commits ?? [] };
            } catch {
              return { cwd, commits: [] as CommitLog[] };
            }
          }),
        );
        if (!alive) return;
        const all: AllCommit[] = results.flatMap((r) =>
          r.commits.map((c) => ({ ...c, cwd: r.cwd })),
        );
        all.sort((a, b) => b.time - a.time);
        setCommits(all);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [api, sessions, active]);

  return { commits, loading };
}
