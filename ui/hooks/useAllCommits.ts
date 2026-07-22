import { useEffect, useRef, useState } from "react";
import type { CommitLog, CommitsResponse } from "../types";
import type { ApiFn } from "./useApi";

/** 跨所有 cwd 合并 git log（概览模块用）。
 *  cwds 由调用方传入(来自 /api/projects 的项目列表),各拉 /api/commits,按 time 倒序合并。
 *  cwd 集合不变不重拉(sig 缓存)。P3 起签名从 sessions 改为 cwds(不再依赖全局 sessions)。 */
export interface AllCommit extends CommitLog {
  cwd: string;
}

export function useAllCommits(api: ApiFn, cwds: string[], active: boolean) {
  const [commits, setCommits] = useState<AllCommit[]>([]);
  const [loading, setLoading] = useState(false);
  const loadedSigRef = useRef("");

  useEffect(() => {
    if (!active) return;
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
  }, [api, cwds, active]);

  return { commits, loading };
}
