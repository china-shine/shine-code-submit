// 「周报」模块:列表展示 /weekly 生成的周报(DATA_DIR/reports/周报-*.html),点击 iframe 查看 HTML。
import { useCallback, useEffect, useState } from "react";
import { useApi } from "../hooks/useApi";
import { useApp } from "../state/AppContext";
import { LoadingBar } from "./LoadingBar";

interface ReportItem {
  date: string;
  filename: string;
}

export function WeeklyReportModule() {
  const { token } = useApp();
  const api = useApi(token);
  const [items, setItems] = useState<ReportItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [html, setHtml] = useState("");
  const [loadingHtml, setLoadingHtml] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      setItems(await api<ReportItem[]>("/api/reports/weekly"));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = async (range: string) => {
    setSel(range);
    setLoadingHtml(true);
    setHtml("");
    try {
      const r = await fetch(`${location.origin}/api/reports/weekly/${range}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setHtml(r.ok ? await r.text() : `<p style="color:#888;padding:1rem">加载失败: HTTP ${r.status}</p>`);
    } catch (e) {
      setHtml(`<p style="color:#c00;padding:1rem">加载失败: ${e instanceof Error ? e.message : String(e)}</p>`);
    } finally {
      setLoadingHtml(false);
    }
  };

  if (loading) {
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

  if (sel) {
    return (
      <div className="report-view" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
        <LoadingBar loading={loadingHtml} />
        <div className="panel-header" style={{ display: "flex", gap: "1rem", alignItems: "baseline" }}>
          <button type="button" className="tab" onClick={() => { setSel(null); setHtml(""); }}>
            ‹ 返回
          </button>
          <b>周报 {sel}</b>
        </div>
        <div style={{ flex: "1 1 0", minHeight: 0 }}>
          <iframe srcDoc={html} sandbox="" style={{ width: "100%", height: "100%", border: 0 }} title={`周报 ${sel}`} />
        </div>
      </div>
    );
  }

  return (
    <div className="report-view" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <LoadingBar loading={loading} />
      <div className="panel-header" style={{ display: "flex", gap: "1.1rem", alignItems: "baseline" }}>
        <b>周报</b>
        <span style={{ marginLeft: "auto" }}>{items.length} 份</span>
        <button type="button" className="tab tab-upload" onClick={() => void load()} title="重新读取列表">
          ↻ 刷新
        </button>
      </div>
      <div style={{ flex: "1 1 0", minHeight: 0, overflow: "auto" }}>
        {items.length === 0 ? (
          <div className="empty-state" style={{ marginTop: "2rem" }}>
            <span className="es-hint">
              暂无周报。运行 <code>/shine-worklog:weekly</code> 生成。
            </span>
          </div>
        ) : (
          <table className="report-table">
            <thead>
              <tr>
                <th className="rt-num">#</th>
                <th>区间</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={it.filename} style={{ cursor: "pointer" }} onClick={() => void open(it.date)}>
                  <td className="rt-num">{i + 1}</td>
                  <td>{it.date}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
