import { useEffect, useRef, useState } from "react";
import type { CommitLog, CommitsResponse } from "../types";
import type { ApiFn } from "./useApi";

/** 拉某 cwd 的 git log（/api/commits）。active=true 且 cwd 存在才拉。
 *  Step 3 下沉：返回自包含 {commits, loading, error, cwd}。loadedCwdRef 换仓库先清空防闪。 */
export function useCommits(api: ApiFn, cwd: string | null, active: boolean) {
  const [commits, setCommits] = useState<CommitLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actualCwd, setActualCwd] = useState<string | null>(null);
  const loadedCwdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (!active || !cwd) return;
    if (loadedCwdRef.current !== cwd) {
      setCommits([]);
      loadedCwdRef.current = cwd;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const data = await api<CommitsResponse>(
          "/api/commits?cwd=" + encodeURIComponent(cwd) + "&limit=200",
        );
        if (alive) {
          setCommits(data.commits);
          setActualCwd(data.cwd);
          setError(data.error ?? null);
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
  }, [api, cwd, active]);

  return { commits, loading, error, cwd: actualCwd };
}
