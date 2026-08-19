// 「设置」模块:上报 + 自动更新 + 版本显示。
// GET /api/settings 读、PUT /api/settings 写;GET /api/health 取当前版本。
// daemon 侧按间隔定时 POST 报表 + 定时检测 npm 新版本自动升级。
import { useEffect, useState } from "react";
import { useApi } from "../hooks/useApi";
import { useApp } from "../state/AppContext";

interface Settings {
  reportUrl?: string | null;
  reportSecret?: string | null;
  reportIntervalMin?: number | null;
  autoUpdate?: boolean | null;
  autoUpdateIntervalMin?: number | null;
  zentaoCacheTtlMin?: number | null;
  latestVersion?: string | null;
  aiSubmitMark?: { enabled: boolean; text: string | null } | null;
}

interface ZentaoConfig {
  url?: string;
  account?: string;
  hasPassword?: boolean;
  projectIds?: string[];
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
  const [secret, setSecret] = useState("");
  const [intervalStr, setIntervalStr] = useState("");
  const [autoUpdate, setAutoUpdate] = useState(true);
  const [updateIntervalStr, setUpdateIntervalStr] = useState("");
  const [cacheTtlStr, setCacheTtlStr] = useState("");
  const [zentaoUrl, setZentaoUrl] = useState("");
  const [zentaoAccount, setZentaoAccount] = useState("");
  const [zentaoPassword, setZentaoPassword] = useState("");
  const [hasZentaoPassword, setHasZentaoPassword] = useState(false);
  const [currentVersion, setCurrentVersion] = useState("");
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [markEnabled, setMarkEnabled] = useState(true);
  const [markText, setMarkText] = useState("本次内容由AI填报");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    Promise.all([
      api<Settings>("/api/settings"),
      fetch(base + "/api/health").then((r) => r.json() as Promise<{ version?: string }>),
      // 禅道配置单独 catch:旧 daemon 无此路由(404)时给空默认,不拖垮整个设置页
      api<ZentaoConfig>("/api/zentao-config").catch(() => ({}) as ZentaoConfig),
    ])
      .then(([s, h, z]) => {
        setUrl(s.reportUrl ?? "");
        setSecret(s.reportSecret ?? "");
        setIntervalStr(s.reportIntervalMin != null ? String(s.reportIntervalMin) : "");
        setAutoUpdate(s.autoUpdate !== false);
        setUpdateIntervalStr(s.autoUpdateIntervalMin != null ? String(s.autoUpdateIntervalMin) : "");
        setCacheTtlStr(s.zentaoCacheTtlMin != null ? String(s.zentaoCacheTtlMin) : "");
        setLatestVersion(s.latestVersion ?? null);
        setMarkEnabled(s.aiSubmitMark?.enabled !== false);
        setMarkText(s.aiSubmitMark?.text ?? "本次内容由AI填报");
        setCurrentVersion(h.version ?? "");
        setZentaoUrl(z.url ?? "");
        setZentaoAccount(z.account ?? "");
        setHasZentaoPassword(!!z.hasPassword);
        setZentaoPassword("");
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
    const ctv = parseInt(cacheTtlStr, 10);
    const body = {
      reportUrl: url.trim() || null,
      reportSecret: secret.trim() || null,
      reportIntervalMin: Number.isFinite(iv) && iv > 0 ? iv : null,
      autoUpdate,
      autoUpdateIntervalMin: Number.isFinite(uiv) && uiv > 0 ? uiv : null,
      zentaoCacheTtlMin: Number.isFinite(ctv) && ctv > 0 ? ctv : null,
      aiSubmitMark: { enabled: markEnabled, text: markText.trim() || null },
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
      setSecret(s.reportSecret ?? "");
      setIntervalStr(s.reportIntervalMin != null ? String(s.reportIntervalMin) : "");
      setAutoUpdate(s.autoUpdate !== false);
      setUpdateIntervalStr(s.autoUpdateIntervalMin != null ? String(s.autoUpdateIntervalMin) : "");
      setCacheTtlStr(s.zentaoCacheTtlMin != null ? String(s.zentaoCacheTtlMin) : "");
      setMarkEnabled(s.aiSubmitMark?.enabled !== false);
      setMarkText(s.aiSubmitMark?.text ?? "本次内容由AI填报");

      // 禅道账号配置(与 settings 同处保存):url/account 恒写,password 非空才更新(留空=不改)
      // 单独 catch:settings 已存,此步失败(旧 daemon 无路由)只提示、不判整次保存失败
      let zentaoSaved = true;
      try {
        const zbody: Record<string, string> = { url: zentaoUrl.trim(), account: zentaoAccount.trim() };
        if (zentaoPassword) zbody.password = zentaoPassword;
        const zres = await fetch(base + "/api/zentao-config", {
          method: "PUT",
          headers: { Authorization: "Bearer " + token, "content-type": "application/json" },
          body: JSON.stringify(zbody),
        });
        if (!zres.ok) throw new Error(String(zres.status));
        const z = (await zres.json()) as ZentaoConfig;
        setZentaoUrl(z.url ?? "");
        setZentaoAccount(z.account ?? "");
        setHasZentaoPassword(!!z.hasPassword);
        setZentaoPassword("");
      } catch {
        zentaoSaved = false;
      }

      setMsg({
        kind: zentaoSaved ? "ok" : "err",
        text: zentaoSaved ? "已保存" : "设置已保存,禅道配置未保存(升级 daemon 后可用)",
      });
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
                <label>上报密钥</label>
                <input
                  className="field-input"
                  type="password"
                  placeholder="与 tokenserver 的 reportSecret 一致;服务端未验签则留空"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  spellCheck={false}
                  autoComplete="new-password"
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
                配了密钥则上报带 HMAC 签名(服务端开了验签时必填,密钥不一致会被拒且不推进水位、不丢数据)。
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
                升级后 daemon 自动重启到新版(版本感知);plugin 需重启 Claude Code 生效。也可命令行手动 <code>shine-worklog update</code>。
              </div>
            </section>

            <section className="sum-section">
              <div className="sum-head">
                <h3>禅道</h3>
              </div>
              <div className="field-row">
                <label>禅道地址</label>
                <input
                  className="field-input"
                  type="url"
                  placeholder="https://easy.shine.com.cn"
                  value={zentaoUrl}
                  onChange={(e) => setZentaoUrl(e.target.value)}
                  spellCheck={false}
                />
              </div>
              <div className="field-row">
                <label>账号</label>
                <input
                  className="field-input"
                  type="text"
                  placeholder="禅道登录账号"
                  value={zentaoAccount}
                  onChange={(e) => setZentaoAccount(e.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>
              <div className="field-row">
                <label>密码</label>
                <input
                  className="field-input"
                  type="password"
                  placeholder={hasZentaoPassword ? "已配置(留空不修改)" : "禅道登录密码"}
                  value={zentaoPassword}
                  onChange={(e) => setZentaoPassword(e.target.value)}
                  spellCheck={false}
                  autoComplete="new-password"
                />
                <span className="field-hint" style={{ padding: 0 }}>
                  {hasZentaoPassword ? "已设置密码,改密码才填,留空保持不变" : "首次填写"}
                </span>
              </div>
              <div className="field-hint">
                与 setup 写入同一位置(DATA_DIR/zenpilot/config.json),配置后 /report、/daily、/weekly 据此连禅道。已配置的字段会显示出来,密码仅显示「已配置」。
              </div>
              <div className="field-row">
                <label>刷新间隔</label>
                <input
                  className="field-input"
                  type="number"
                  min={0}
                  placeholder="300"
                  value={cacheTtlStr}
                  onChange={(e) => setCacheTtlStr(e.target.value)}
                  style={{ flex: "0 0 120px" }}
                />
                <span className="field-hint" style={{ padding: 0 }}>
                  分钟(超过此间隔,下次用 /report、/daily、/weekly 时自动重拉禅道任务与项目;0 = 仅手动刷新)
                </span>
              </div>
              <div className="field-hint">
                禅道任务/项目缓存(cache.json)默认命中即复用。设了 TTL 后,过期会在下次填报/生成报表时自动重拉,无需手动 refresh。改完无需重启。
              </div>
            </section>

            <section className="sum-section">
              <div className="sum-head">
                <h3>AI 提交标识</h3>
              </div>
              <div className="field-row">
                <label>启用</label>
                <input
                  type="checkbox"
                  checked={markEnabled}
                  onChange={(e) => setMarkEnabled(e.target.checked)}
                />
                <span className="field-hint" style={{ padding: 0 }}>
                  开启后 /report 提交禅道工时时,在 work 末尾追加标识行;/daily /weekly 据此对账统计 AI 代报工时
                </span>
              </div>
              <div className="field-row">
                <label>标识文案</label>
                <input
                  className="field-input"
                  type="text"
                  placeholder="本次内容由AI填报"
                  value={markText}
                  onChange={(e) => setMarkText(e.target.value)}
                  spellCheck={false}
                />
                <span className="field-hint" style={{ padding: 0 }}>
                  拼到工作内容末尾的独立一行;留空恢复默认文案
                </span>
              </div>
              <div className="field-hint">
                标识随禅道 effort 走,不依赖本地台账;改文案后历史提交需按旧文案才能被报表识别。命令行亦可用 <code>shine-worklog mark --show/--on/--off/--text</code>。
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
