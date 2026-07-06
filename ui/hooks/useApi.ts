import { useCallback } from "react";

/** 带鉴权 token 的 fetch 封装；返回稳定引用（仅依赖 token）。 */
export function useApi(token: string) {
  const base = location.origin;
  return useCallback(async function api<T>(path: string): Promise<T> {
    const res = await fetch(base + path, { headers: { Authorization: "Bearer " + token } });
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
    return res.json() as Promise<T>;
  }, [token]);
}

export type ApiFn = <T>(path: string) => Promise<T>;
