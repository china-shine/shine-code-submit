// 「设置」模块:上报 + 自动更新 + 版本显示。
// GET /api/settings 读、PUT /api/settings 写;GET /api/health 取当前版本。
// daemon 侧按间隔定时 POST 报表 + 定时检测 npm 新版本自动升级。
import { useEffect, useState } from "react";
import { useApi } from "../hooks/useApi";
import { useApp } from "../state/AppContext";

interface Settings {
  reportUrl?: string | null;
  reportIntervalMin?: number | null;
  autoUpdate?: boolean | null;
  autoUpdateIntervalMin?: number | null;
  latestVersion?: string | null;
}

const SAVE_BTN: React.CSSProperties = {
  background: "#4f8cff",
  color: "#fff",
  border: "none",
  borderRadius: 4,
  padding: "0.55rem 1.6rem",
  fontSize: "var(--fs-sm)",
  fontWeight: 600,
  cursor: "pointer",
};

export function SettingsModule() {
  const { token } = useApp();
  const api = useApi(token);
  const base = location.origin;
  const [url, setUrl] = useState("");
  const [intervalStr, setIntervalStr] = useState("");
  const [autoUpdate, setAutoUpdate] = useState(true);
  const [updateIntervalStr, setUpdateIntervalStr] = useState("");
  const [currentVersion, setCurrentVersion] = useState("");
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    Promise.all([
      api<Settings>("/api/settings"),
      fetch(base + "/api/health").then((r) => r.json() as Promise<{ version?: string }>),
    ])
      .then(([s, h]) => {
        setUrl(s.reportUrl ?? "");
        setIntervalStr(s.reportIntervalMin != null ? String(s.reportIntervalMin) : "");
        setAutoUpdate(s.autoUpdate !== false);
        setUpdateIntervalStr(s.autoUpdateIntervalMin != null ? String(s.autoUpdateIntervalMin) : "");
        setLatestVersion(s.latestVersion ?? null);
        setCurrentVersion(h.version ?? "");
        setLoading(false);
      })
      .catch(() => {
        setMsg({ kind: "err", text: "读取设置失败" });
        setLoading(false);
      });
  }, [api, base]);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    const iv = parseInt(intervalStr, 10);
    const uiv = parseInt(updateIntervalStr, 10);
    const body = {
      reportUrl: url.trim() || null,
      reportIntervalMin: Number.isFinite(iv) && iv > 0 ? iv : null,
      autoUpdate,
      autoUpdateIntervalMin: Number.isFinite(uiv) && uiv > 0 ? uiv : null,
    };
    try {
      const res = await fetch(base + "/api/settings", {
        method: "PUT",
        headers: { Authorization: "Bearer " + token, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(String(res.status));
      const s = (await res.json()) as Settings;
      setUrl(s.reportUrl ?? "");
      setIntervalStr(s.reportIntervalMin != null ? String(s.reportIntervalMin) : "");
      setAutoUpdate(s.autoUpdate !== false);
      setUpdateIntervalStr(s.autoUpdateIntervalMin != null ? String(s.autoUpdateIntervalMin) : "");
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
          <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
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
              </div>
              <div className="field-row">
                <label>上报间隔</label>
                <input
                  className="field-input"
                  type="number"
                  min={1}
                  placeholder="0 = 不自动上报"
                  value={intervalStr}
                  onChange={(e) => setIntervalStr(e.target.value)}
                  spellCheck={false}
                  style={{ flex: "0 0 120px" }}
                />
                <span className="field-hint" style={{ padding: 0 }}>
                  分钟(填了地址且间隔大于 0 才会自动上报)
                </span>
              </div>
              <div className="field-hint">
                daemon 每分钟检查一次:地址 + 间隔都配了,就把「报表」数据 POST 到该地址;留空 / 间隔 0 = 不上报。改完无需重启。
              </div>
            </section>

            <section className="sum-section">
              <div className="sum-head">
                <h3>自动更新</h3>
              </div>
              <div className="field-row">
                <label>版本</label>
                <span className="field-hint" style={{ padding: 0 }}>
                  当前 v{currentVersion || "?"}
                  {latestVersion && latestVersion !== currentVersion
                    ? `（npm 最新 v${latestVersion}）`
                    : "（已是最新）"}
                </span>
              </div>
              <div className="field-row">
                <label>自动更新</label>
                <input
                  type="checkbox"
                  checked={autoUpdate}
                  onChange={(e) => setAutoUpdate(e.target.checked)}
                />
                <span className="field-hint" style={{ padding: 0 }}>
                  开启后 daemon 启动时 + 定时检测 npm 新版本,有新版自动后台升级
                </span>
              </div>
              <div className="field-row">
                <label>检测间隔</label>
                <input
                  className="field-input"
                  type="number"
                  min={1}
                  placeholder="60"
                  value={updateIntervalStr}
                  onChange={(e) => setUpdateIntervalStr(e.target.value)}
                  style={{ flex: "0 0 120px" }}
                />
                <span className="field-hint" style={{ padding: 0 }}>
                  分钟(daemon 每分钟 tick,按此间隔节流)
                </span>
              </div>
              <div className="field-hint">
                升级后 daemon 自动重启到新版(版本感知);plugin 需重启 Claude Code 生效。也可命令行手动 <code>shine-code-submit update</code>。
              </div>
            </section>

            {/* 保存按钮:独立行,设置页底部居右,蓝底白字醒目 */}
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                alignItems: "center",
                gap: "0.8rem",
                padding: "0.2rem 0.2rem 0",
              }}
            >
              {msg && <span className={msg.kind === "ok" ? "field-ok" : "field-err"}>{msg.text}</span>}
              <button
                type="button"
                onClick={save}
                disabled={saving}
                title="保存设置"
                style={{ ...SAVE_BTN, cursor: saving ? "default" : "pointer", opacity: saving ? 0.6 : 1 }}
              >
                {saving ? "保存中…" : "💾 保存设置"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
