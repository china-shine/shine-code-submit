// 「设置」模块:目前只有「上报地址」(reportUrl)。
// GET /api/settings 读、PUT /api/settings 写。后期「报表」模块的上报按钮读这个地址。
import { useEffect, useState } from "react";
import { useApi } from "../hooks/useApi";
import { useApp } from "../state/AppContext";

interface Settings {
  reportUrl?: string | null;
}

export function SettingsModule() {
  const { token } = useApp();
  const api = useApi(token);
  const base = location.origin;
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    api<Settings>("/api/settings")
      .then((s) => {
        setUrl(s.reportUrl ?? "");
        setLoading(false);
      })
      .catch(() => {
        setMsg({ kind: "err", text: "读取设置失败" });
        setLoading(false);
      });
  }, [api]);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch(base + "/api/settings", {
        method: "PUT",
        headers: { Authorization: "Bearer " + token, "content-type": "application/json" },
        body: JSON.stringify({ reportUrl: url.trim() || null }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const s = (await res.json()) as Settings;
      setUrl(s.reportUrl ?? "");
      setMsg({ kind: "ok", text: "已保存" });
      setTimeout(() => setMsg(null), 2000);
    } catch {
      setMsg({ kind: "err", text: "保存失败,请重试" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="stats-view">
      <div className="panel-header">
        <h2>设置</h2>
      </div>
      <div className="stats-body">
        {loading ? (
          <div className="sum-empty">加载中…</div>
        ) : (
          <>
            <section className="sum-section">
              <div className="sum-head">
                <h3>上报</h3>
              </div>
              <div className="field-row">
                <label>上报地址</label>
                <input
                  className="field-input"
                  type="url"
                  placeholder="https://your-server/api/report"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="tab"
                  onClick={save}
                  disabled={saving}
                  title="保存上报地址"
                >
                  {saving ? "保存中…" : "保存"}
                </button>
                {msg && (
                  <span className={msg.kind === "ok" ? "field-ok" : "field-err"}>{msg.text}</span>
                )}
              </div>
              <div className="field-hint">
                配置后,「报表」模块的上报按钮会把数据 POST 到这个地址(上报功能后期启用)。留空=不配置。
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
