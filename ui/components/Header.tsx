import { Icon } from "./Icon";
import { Status } from "./Status";
import { useApp } from "../state/AppContext";
import { useState } from "react";

type Msg = { text: string; kind: "info" | "ok" | "err" };

/** 顶栏：标题 + 手动检查更新 + 运行状态。 */
export function Header() {
  const { token } = useApp();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg | null>(null);

  const checkUpdate = async (): Promise<void> => {
    setBusy(true);
    setMsg({ text: "检查中…", kind: "info" });
    try {
      const r = await fetch(`${location.origin}/api/update`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const j = (await r.json().catch(() => ({}))) as { updated?: boolean; latest?: string | null; current?: string };
      if (j.updated) setMsg({ text: `✨ 发现新版 v${j.latest},升级中,daemon 重启…`, kind: "ok" });
      else if (j.latest) setMsg({ text: `已是最新 v${j.current}`, kind: "info" });
      else setMsg({ text: "检查失败(npm 不可达?)", kind: "err" });
    } catch {
      setMsg({ text: "请求失败", kind: "err" });
    }
    setBusy(false);
  };

  return (
    <header>
      <div className="title">
        <Icon name="diamond" size={14} />
        <span>Shine Worklog</span>
      </div>
      <div className="hdr-update">
        <button
          type="button"
          className="update-btn"
          onClick={checkUpdate}
          disabled={busy}
          title="检查 npm 最新版,有新版则升级(daemon 自动重启;当前 Claude 会话需重启生效)"
        >
          <span className={busy ? "spin" : ""}>⤓</span> 检查更新
        </button>
        {msg && <span className={`update-msg ${msg.kind}`}>{msg.text}</span>}
      </div>
      <Status />
    </header>
  );
}
