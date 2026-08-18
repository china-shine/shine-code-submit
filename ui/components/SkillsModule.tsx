// 「Skills」模块:编辑当前生效插件根 skills/ 下的 Markdown 文档(各 skill 的 SKILL.md)。
// skill 文件是命令触发时从磁盘读 → 保存即生效,无需重启 Claude Code 或 daemon;
// 保存同时备份到 DATA_DIR/skills-edits/,autoUpdate 升级整目录覆盖后磁盘与备份分叉 → stale 提示手动恢复。
// 只开放 .md:.ts 是代码,不在 dashboard 动,走源码仓库改。
import { useCallback, useEffect, useState } from "react";
import { useApi } from "../hooks/useApi";
import { useApp } from "../state/AppContext";
import { Markdown } from "./Markdown";
import { CodeEditor } from "./CodeEditor";

interface SkillFile {
  rel: string;
  size: number;
  mtimeMs: number;
  edited: boolean;
  editVersion: string | null;
  useCount: number; // 近 7 天 Skill 调用次数(server 已按此降序排,高频 tab 靠左)
}

interface SkillsResponse {
  root: string;
  version: string;
  sourceMode: boolean;
  files: SkillFile[];
  stale: Array<{ rel: string; editVersion: string; savedAt: number }>;
}

interface FileResponse {
  rel: string;
  content: string;
  size: number;
  mtimeMs: number;
}

const SAVE_BTN: React.CSSProperties = {
  background: "#4f8cff",
  color: "#fff",
  border: "none",
  borderRadius: 4,
  padding: "0.45rem 1.2rem",
  fontSize: "var(--fs-sm)",
  fontWeight: 600,
  cursor: "pointer",
};

function fmtSize(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;
}

export function SkillsModule() {
  const { token } = useApp();
  const api = useApi(token);
  const base = location.origin;
  const [data, setData] = useState<SkillsResponse | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [loaded, setLoaded] = useState(""); // 已保存内容:content !== loaded 即 dirty
  const [fileMtime, setFileMtime] = useState(0); // 加载时 mtime,保存护栏(409)用
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const reload = useCallback(() => {
    return api<SkillsResponse>("/api/skills")
      .then((d) => {
        setData(d);
        setLoadErr(null);
      })
      .catch((e: unknown) => setLoadErr(e instanceof Error ? e.message : "加载失败(旧 daemon 无此接口,升级后可用)"));
  }, [api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 默认打开最左侧(使用频率最高)的 skill;仅首次(selected 为空)自动选,保存/恢复后的刷新不重置
  useEffect(() => {
    if (selected == null && data?.files.length) void open(data.files[0]!.rel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const dirty = content !== loaded;

  const open = async (rel: string) => {
    if (selected === rel) return;
    if (dirty && !confirm("有未保存的修改,放弃?")) return;
    try {
      const f = await api<FileResponse>(`/api/skills/file?path=${encodeURIComponent(rel)}`);
      setSelected(rel);
      setContent(f.content);
      setLoaded(f.content);
      setFileMtime(f.mtimeMs);
      setPreview(false);
      setMsg(null);
    } catch {
      setMsg({ kind: "err", text: "读取失败" });
    }
  };

  const doSave = async (force: boolean) => {
    if (selected == null) return;
    setSaving(true);
    setMsg(null);
    try {
      const body: Record<string, unknown> = { path: selected, content };
      if (!force) body.baseMtimeMs = fileMtime;
      const res = await fetch(base + "/api/skills/file", {
        method: "PUT",
        headers: { Authorization: "Bearer " + token, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 409) {
        if (confirm("文件在编辑期间已被修改(其他标签页/外部程序),仍要覆盖?")) {
          setSaving(false);
          return doSave(true);
        }
        return;
      }
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? String(res.status));
      }
      const j = (await res.json()) as { mtimeMs: number; version: string };
      setLoaded(content);
      setFileMtime(j.mtimeMs);
      setMsg({ kind: "ok", text: `已保存,下次执行命令即生效(v${j.version} 目录)` });
      setTimeout(() => setMsg(null), 2500);
      void reload(); // edited 圆点亮起
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "保存失败" });
    } finally {
      setSaving(false);
    }
  };

  const restore = async (rel: string) => {
    setRestoring(rel);
    setMsg(null);
    try {
      const res = await fetch(base + "/api/skills/restore", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "content-type": "application/json" },
        body: JSON.stringify({ path: rel }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string; restoredFrom?: string };
      if (!res.ok) throw new Error(j.error ?? String(res.status));
      setMsg({ kind: "ok", text: `已从 v${j.restoredFrom ?? "?"} 的备份恢复 ${rel}` });
      setTimeout(() => setMsg(null), 2500);
      await reload();
      if (selected === rel) {
        // 当前打开的就是被恢复文件:重载内容
        const f = await api<FileResponse>(`/api/skills/file?path=${encodeURIComponent(rel)}`);
        setContent(f.content);
        setLoaded(f.content);
        setFileMtime(f.mtimeMs);
      }
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "恢复失败" });
    } finally {
      setRestoring(null);
    }
  };

  const copy = async () => {
    // 局域网 IP 访问(非 localhost/非 https)时 navigator.clipboard 不可用 → 回退 textarea+execCommand
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(content);
      } else {
        const ta = document.createElement("textarea");
        ta.value = content;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        if (!ok) throw new Error("execCommand copy failed");
      }
      setMsg({ kind: "ok", text: "已复制——可粘贴回仓库 skills/ 随下版发布" });
      setTimeout(() => setMsg(null), 2500);
    } catch {
      setMsg({ kind: "err", text: "复制失败,请手动全选复制" });
    }
  };

  const resetNow = async () => {
    if (selected == null) return;
    setConfirmReset(false);
    setResetting(true);
    setMsg(null);
    try {
      const res = await fetch(base + "/api/skills/reset", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "content-type": "application/json" },
        body: JSON.stringify({ path: selected }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? String(res.status));
      const f = await api<FileResponse>(`/api/skills/file?path=${encodeURIComponent(selected)}`);
      setContent(f.content);
      setLoaded(f.content);
      setFileMtime(f.mtimeMs);
      setMsg({ kind: "ok", text: "已重置到首次编辑前的原始内容" });
      setTimeout(() => setMsg(null), 2500);
      void reload();
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "重置失败" });
    } finally {
      setResetting(false);
    }
  };

  const openBackup = async () => {
    setMsg(null);
    try {
      const res = await fetch(base + "/api/skills/open-backup", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "content-type": "application/json" },
        body: "{}",
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string; path?: string };
      if (!res.ok) throw new Error(j.error ?? String(res.status));
      setMsg({ kind: "ok", text: `已打开备份目录 ${j.path ?? ""}` });
      setTimeout(() => setMsg(null), 4000);
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "打开备份目录失败" });
    }
  };

  // Ctrl+S / Cmd+S 保存(有未保存修改且非保存中才触发)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (selected && dirty && !saving) void doSave(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, dirty, saving, content, fileMtime]);

  const download = () => {
    if (selected == null) return;
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = selected.split("/").pop() ?? "skill.md";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (loadErr) {
    return (
      <div className="stats-view">
        <div className="panel-header">
          <h2>Skills</h2>
        </div>
        <div className="stats-body">
          <div className="sum-empty">{loadErr}</div>
        </div>
      </div>
    );
  }

  return (
    <>
      {confirmReset && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}
          onClick={() => setConfirmReset(false)}
        >
          <div
            style={{ background: "var(--titlebar)", color: "var(--text)", border: "1px solid var(--border-light)", borderRadius: 8, padding: "20px 24px", maxWidth: 380, boxShadow: "0 20px 60px rgba(0,0,0,0.45)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>确认重置?</div>
            <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 18, lineHeight: 1.5 }}>
              将把「{selected?.split("/")[0]}」恢复到首次编辑前的原始内容,当前修改会丢失。
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" className="tool-btn" onClick={() => setConfirmReset(false)}>取消</button>
              <button type="button" className="tool-btn" style={{ background: "#ef4444", borderColor: "#ef4444", color: "#fff" }} onClick={() => void resetNow()}>
                重置
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="stats-view">
      <div className="panel-header">
        <h2>Skills</h2>
        {data && (
          <>
            <span className="field-hint" style={{ padding: 0 }}>
              v{data.version} · {data.files.length} 个文件 · {data.root}
            </span>
            <button
              type="button"
              className="tool-btn"
              onClick={() => void openBackup()}
              title="在系统文件管理器打开备份目录 DATA_DIR/skills-edits/——升级后 skills/ 被覆盖时可手动查看/拷贝备份内容"
            >
              📂 打开备份目录
            </button>
          </>
        )}
      </div>
      <div className="stats-body">
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", minHeight: 0, height: "100%" }}>
          {!!data?.stale.length && (
            <div className="field-hint" style={{ border: "1px solid rgba(255,80,80,0.5)", borderRadius: 4, padding: "0.4rem 0.6rem", display: "flex", flexDirection: "column", gap: "0.35rem" }}>
              <div>
                有 {data.stale.length} 个本地编辑与磁盘不一致(可能被升级覆盖 / install --force / 外部修改):
              </div>
              {data.stale.map((s) => (
                <div key={s.rel} style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
                  <span>
                    {s.rel}(编辑于 v{s.editVersion})
                  </span>
                  <button type="button" className="tool-btn" onClick={() => restore(s.rel)} disabled={restoring === s.rel} style={{ padding: "0.15rem 0.7rem" }}>
                    {restoring === s.rel ? "恢复中…" : "恢复备份"}
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* tab 导航:skill 名为 tab(●=有本地编辑,*=未保存),工具按钮行尾;窄窗口 tab 区横向滚动 */}
          <div className="skill-tabs">
            <div className="skill-tab-scroll">
              {data == null ? null : data.files.map((f) => (
                <button
                  key={f.rel}
                  type="button"
                  className={`tab${selected === f.rel ? " active" : ""}`}
                  onClick={() => void open(f.rel)}
                  title={`${f.rel}${f.useCount ? ` · 近7天调用 ${f.useCount} 次` : ""}`}
                >
                  {f.edited && <span className="skill-dot">●</span>}
                  {f.rel.split("/")[0]}
                  {selected === f.rel && dirty && <span className="skill-dot">*</span>}
                </button>
              ))}
            </div>
            {selected != null && (
              <div className="skill-actions">
                {msg && <span className={msg.kind === "ok" ? "field-ok" : "field-err"} style={{ fontSize: "var(--fs-xs)" }}>{msg.text}</span>}
                <button type="button" className="tool-btn" onClick={() => setPreview(!preview)}>
                  {preview ? "编辑" : "预览"}
                </button>
                <button type="button" className="tool-btn" onClick={() => void copy()} title="复制全文,可粘贴回仓库 skills/ 随下版发布">
                  复制
                </button>
                <button type="button" className="tool-btn" onClick={download}>
                  下载
                </button>
                <button type="button" className="tool-btn" onClick={() => setConfirmReset(true)} disabled={resetting} title="恢复到首次编辑前的原始内容">
                  {resetting ? "重置中…" : "重置"}
                </button>
                <button
                  type="button"
                  onClick={() => void doSave(false)}
                  disabled={saving || !dirty}
                  title="保存即生效——Claude Code 下次执行对应命令就读到新内容"
                  style={{ ...SAVE_BTN, cursor: saving || !dirty ? "default" : "pointer", opacity: !dirty || saving ? 0.5 : 1 }}
                >
                  {saving ? "保存中…" : "💾 保存"}
                </button>
              </div>
            )}
          </div>

          {/* 编辑区:撑满剩余高度 */}
          {data == null ? (
            <div className="sum-empty" style={{ flex: 1 }}>加载中…</div>
          ) : selected == null ? (
            <div className="sum-empty" style={{ flex: 1 }}>
              点击上方 tab 编辑对应 SKILL.md;保存即生效——Claude Code 下次执行对应命令就读到新内容。
              发新版会整目录覆盖本地编辑,保存时自动备份、届时此处提示恢复。
            </div>
          ) : preview ? (
            <div className="sum-section" style={{ overflowY: "auto", flex: 1, minHeight: 0 }}>
              <Markdown src={content} />
            </div>
          ) : (
            <div style={{ flex: 1, minHeight: 0, borderRadius: 4, border: "1px solid rgba(127,127,127,0.35)", overflow: "hidden", display: "flex", flexDirection: "column" }}>
              <CodeEditor value={content} onChange={setContent} />
            </div>
          )}
        </div>
      </div>
      </div>
    </>
  );
}
