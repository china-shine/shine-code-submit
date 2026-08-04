// 「禅道」模块:只读展示 zentao cache.json(任务/项目/fetchedAt/过期状态)。
// daemon 不调禅道,仅读本地 JSON;「↻ 刷新」只重读文件,更新禅道数据走 /shine-worklog:report。
import { useCallback, useEffect, useState } from "react";
import { useApi } from "../hooks/useApi";
import { useApp } from "../state/AppContext";
import { LoadingBar } from "./LoadingBar";

interface ZentaoTask {
  id: number;
  name: string | null;
  status: string | null;
  estimate: number | null;
  consumed: number | null;
  left: number | null;
  project: number | null;
  execution: number | null;
  executionName: string | null;
}
interface ZentaoProject {
  id: number;
  name: string;
  lastEdited: string | null;
}
interface ZentaoCache {
  fetchedAt?: string;
  projects?: ZentaoProject[];
  tasks?: ZentaoTask[];
}
interface Payload {
  cache: ZentaoCache | null;
  ttl: number | null;
  expired: boolean;
  zentaoUrl: string | null;
}

/** 本地无时区 ISO → 本地时间串(对齐 zentao.ts nowISOSeconds 的写入口径)。 */
function fmtDT(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function ZentaoCacheModule() {
  const { token } = useApp();
  const api = useApi(token);
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<"tasks" | "projects">("tasks");

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      setData(await api<Payload>("/api/zentao-cache"));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !data) {
    return (
      <div className="empty-state">
        <span className="es-hint">加载中…</span>
      </div>
    );
  }
  if (err) {
    return (
      <div className="empty-state">
        <span className="es-hint">读取失败:{err}</span>
      </div>
    );
  }
  if (!data) return null;

  const cache = data.cache;
  const tasks = cache?.tasks ?? [];
  const projects = cache?.projects ?? [];
  const projName = (pid: number | null): string =>
    pid == null ? "—" : projects.find((p) => p.id === pid)?.name ?? `#${pid}`;

  return (
    <div className="report-view" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <LoadingBar loading={loading} />
      <div
        className="panel-header"
        style={{ display: "flex", gap: "1.1rem", alignItems: "baseline", flexWrap: "wrap" }}
      >
        <b>禅道</b>
        <span style={{ marginLeft: "auto" }}>
          {cache ? `${tasks.length} 任务 · ${projects.length} 项目` : "无缓存"}
        </span>
        <button type="button" className="tab tab-upload" onClick={() => void load()} title="重新读取本地缓存">
          ↻ 刷新
        </button>
      </div>

      {!cache ? (
        <div className="empty-state" style={{ marginTop: "2rem" }}>
          <span className="es-hint">
            未生成缓存。运行 <code>/shine-worklog:report</code> 后自动拉取禅道任务与项目。
          </span>
        </div>
      ) : (
        <>
          <div
            className="field-hint"
            style={{ padding: "0.3rem 0.2rem", display: "flex", gap: "1rem", flexWrap: "wrap", alignItems: "baseline" }}
          >
            <span>
              最后拉取<b style={{ marginLeft: 4 }}>{fmtDT(cache.fetchedAt)}</b>
            </span>
            <span>TTL:{data.ttl ? `${data.ttl} 分钟` : "未启用(仅手动刷新)"}</span>
            <span className={data.expired ? "field-err" : "field-ok"}>
              {data.expired ? "● 已过期(下次填报将自动重拉)" : "● 有效"}
            </span>
          </div>
          <div className="field-hint" style={{ padding: "0 0.2rem 0.4rem" }}>
            💡 更新禅道数据请运行 <code>/shine-worklog:report</code>;此处「刷新」仅重读本地缓存文件。
          </div>

          <div style={{ display: "flex", gap: "0.4rem", padding: "0.2rem 0.2rem 0.4rem" }}>
            <button
              type="button"
              className="tab"
              style={tab === "tasks" ? { background: "#4f8cff", color: "#fff", borderColor: "#4f8cff" } : {}}
              onClick={() => setTab("tasks")}
            >
              任务({tasks.length})
            </button>
            <button
              type="button"
              className="tab"
              style={tab === "projects" ? { background: "#4f8cff", color: "#fff", borderColor: "#4f8cff" } : {}}
              onClick={() => setTab("projects")}
            >
              项目({projects.length})
            </button>
          </div>

          <div style={{ flex: "1 1 0", minHeight: 0, overflow: "auto" }}>
            {tab === "tasks" ? (
              <table className="report-table">
                <thead>
                  <tr>
                    <th className="rt-num">#</th>
                    <th>任务</th>
                    <th>状态</th>
                    <th className="rt-num">预估</th>
                    <th className="rt-num">消耗</th>
                    <th className="rt-num">剩余</th>
                    <th>项目</th>
                    <th>执行</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.length === 0 ? (
                    <tr>
                      <td colSpan={8} style={{ textAlign: "center", color: "var(--muted)" }}>
                        无任务
                      </td>
                    </tr>
                  ) : (
                    tasks.map((t, i) => {
                      const name = t.name ?? `#${t.id}`;
                      const link = data.zentaoUrl
                        ? `${data.zentaoUrl}/index.php?m=task&f=view&taskID=${t.id}`
                        : null;
                      return (
                        <tr key={t.id}>
                          <td className="rt-num">{i + 1}</td>
                          <td>
                            {link ? (
                              <a href={link} target="_blank" rel="noopener" style={{ textDecoration: "none" }}>
                                {name}
                              </a>
                            ) : (
                              name
                            )}
                            <span style={{ color: "var(--muted)", fontSize: "0.85em", marginLeft: 4 }}>#{t.id}</span>
                          </td>
                          <td>{t.status ?? "—"}</td>
                          <td className="rt-num">{t.estimate ?? "—"}</td>
                          <td className="rt-num">{t.consumed ?? "—"}</td>
                          <td className="rt-num">{t.left ?? "—"}</td>
                          <td>{projName(t.project)}</td>
                          <td>{t.executionName ?? "—"}</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            ) : (
              <table className="report-table">
                <thead>
                  <tr>
                    <th className="rt-num">#</th>
                    <th className="rt-num">ID</th>
                    <th>项目</th>
                    <th>最后编辑</th>
                  </tr>
                </thead>
                <tbody>
                  {projects.length === 0 ? (
                    <tr>
                      <td colSpan={4} style={{ textAlign: "center", color: "var(--muted)" }}>
                        无项目
                      </td>
                    </tr>
                  ) : (
                    projects.map((p, i) => (
                      <tr key={p.id}>
                        <td className="rt-num">{i + 1}</td>
                        <td className="rt-num">{p.id}</td>
                        <td>{p.name}</td>
                        <td>{fmtDT(p.lastEdited)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
