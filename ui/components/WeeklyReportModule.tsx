// 「周报」模块:列表展示 /weekly 生成的周报(DATA_DIR/reports/周报-*.html),点击新窗口预览,支持批量下载/删除。
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
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [delTarget, setDelTarget] = useState<string | null>(null);
  const [batchDel, setBatchDel] = useState(false);
  const [batchDl, setBatchDl] = useState(false);

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

  const toggle = (range: string) =>
    setChecked((prev) => {
      const n = new Set(prev);
      if (n.has(range)) n.delete(range);
      else n.add(range);
      return n;
    });

  const toggleAll = () => {
    if (checked.size === items.length) setChecked(new Set());
    else setChecked(new Set(items.map((it) => it.date)));
  };

  const open = async (range: string) => {
    const r = await fetch(`${location.origin}/api/reports/weekly/${range}`, { headers: { Authorization: `Bearer ${token}` } });
    window.open(URL.createObjectURL(await r.blob()), "_blank");
  };

  const download = async (range: string) => {
    const r = await fetch(`${location.origin}/api/reports/weekly/${range}`, { headers: { Authorization: `Bearer ${token}` } });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(await r.blob());
    a.download = `周报-${range}.html`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const batchDownload = async () => {
    setBatchDl(true);
    try {
      for (const range of checked) {
        await download(range);
        await new Promise((r) => setTimeout(r, 200));
      }
    } finally {
      setBatchDl(false);
    }
  };

  const confirmDel = async () => {
    const targets = batchDel ? [...checked] : delTarget ? [delTarget] : [];
    if (!targets.length) return;
    for (const range of targets) {
      await fetch(`${location.origin}/api/reports/weekly/${range}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    }
    setDelTarget(null);
    setBatchDel(false);
    setChecked(new Set());
    await load();
  };

  const showDelConfirm = batchDel || delTarget !== null;
  const delCount = batchDel ? checked.size : delTarget ? 1 : 0;

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

  return (
    <>
    {showDelConfirm && (
      <div style={{ position:"fixed", inset:0, background:"rgba(15,23,42,.45)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000 }}
           onClick={() => { setDelTarget(null); setBatchDel(false); }}>
        <div style={{ background:"#fff", borderRadius:12, padding:"24px 28px", maxWidth:360, boxShadow:"0 20px 60px rgba(0,0,0,.3)" }}
             onClick={(e) => e.stopPropagation()}>
          <div style={{ fontSize:15, fontWeight:700, marginBottom:8 }}>确认删除{delCount > 1 ? ` ${delCount} 份` : ""}周报?</div>
          <div style={{ fontSize:13, color:"var(--muted)", marginBottom:18 }}>此操作不可恢复。</div>
          <div style={{ display:"flex", gap:8, justifyContent:"flex-end" }}>
            <button type="button" className="tab" onClick={() => { setDelTarget(null); setBatchDel(false); }}>取消</button>
            <button type="button" className="tab" style={{ background:"#ef4444", color:"#fff", borderColor:"#ef4444" }} onClick={() => void confirmDel()}>删除</button>
          </div>
        </div>
      </div>
    )}
    <div className="report-view" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <LoadingBar loading={loading} />
      <div className="panel-header" style={{ display: "flex", gap: "0.6rem", alignItems: "baseline", flexWrap: "wrap" }}>
        <b>周报</b>
        <span style={{ color: "var(--muted)" }}>{items.length} 份{checked.size > 0 ? ` · 已选 ${checked.size}` : ""}</span>
        <span style={{ marginLeft: "auto", display: "flex", gap: "0.4rem" }}>
          <button type="button" className="tab" disabled={checked.size === 0 || batchDl} onClick={() => void batchDownload()} title="下载选中">
            {batchDl ? "下载中…" : "⬇ 批量下载"}
          </button>
          <button type="button" className="tab" disabled={checked.size === 0} onClick={() => setBatchDel(true)} title="删除选中" style={checked.size > 0 ? { color: "#ef4444" } : {}}>
            🗑 批量删除
          </button>
          <button type="button" className="tab tab-upload" onClick={() => void load()} title="重新读取列表">
            ↻ 刷新
          </button>
        </span>
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
                <th style={{ width: 32 }}>
                  <input type="checkbox" checked={checked.size === items.length && items.length > 0} onChange={() => toggleAll()} />
                </th>
                <th className="rt-num">#</th>
                <th>区间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={it.filename}>
                  <td><input type="checkbox" checked={checked.has(it.date)} onChange={() => toggle(it.date)} /></td>
                  <td className="rt-num">{i + 1}</td>
                  <td style={{ cursor: "pointer", color: "var(--accent)" }} onClick={() => void open(it.date)}>{it.date}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button type="button" className="tab" onClick={() => void download(it.date)}>下载</button>{" "}
                    <button type="button" className="tab" onClick={() => setDelTarget(it.date)}>删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
    </>
  );
}
