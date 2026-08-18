// 「Skills」模块:编辑当前生效插件根 skills/ 下的 Markdown 文档(各 skill 的 SKILL.md)。
// skill 文件是命令触发时从磁盘读 → 保存即生效,无需重启 Claude Code 或 daemon;
// 保存同时备份到 DATA_DIR/skills-edits/,autoUpdate 升级整目录覆盖后磁盘与备份分叉 → stale 提示手动恢复。
// 只开放 .md:.ts 是代码,不在 dashboard 动,走源码仓库改。
import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "../hooks/useApi";
import { useApp } from "../state/AppContext";
import { Markdown } from "./Markdown";
import { CodeEditor, DiffEditor } from "./CodeEditor";

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

// 「修改后的 skills」视图:编辑备份(按插件版本留痕)的分组列表与单份内容
interface EditGroup {
  rel: string;
  versions: Array<{ version: string; savedAt: number }>; // savedAt 降序
  stale: boolean; // 磁盘 ≠ 最新备份(可能被升级覆盖 / 外部手改)
}

interface EditContent {
  rel: string;
  version: string;
  savedAt: number;
  content: string;
}

// 通用确认弹窗(替代原生 confirm,全模块统一):重置/恢复到实时/放弃未保存/覆盖外部修改共用
interface ConfirmReq {
  title: string;
  body: string;
  okText: string;
  danger?: boolean; // true=红色确认键(破坏性操作)
  onOk: () => void;
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

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 保存点下拉(自绘:深色主题下原生 select 弹层是系统白底,观感突兀)。
 *  触发键与 tool-btn 同款,弹层右对齐垂下;首项标「最新」,当前选中高亮。 */
function SnapshotMenu({
  value,
  options,
  onPick,
}: {
  value: string; // "version@savedAt"
  options: Array<{ version: string; savedAt: number }>; // savedAt 降序
  onPick: (version: string, savedAt: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const cur = options.find((v) => `${v.version}@${v.savedAt}` === value);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        className="tool-btn"
        onClick={() => setOpen(!open)}
        title="切换保存点(同版本留最近 10 次快照)"
        style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
      >
        <span style={{ fontSize: "var(--fs-xs)" }}>🕘</span>
        <span style={{ fontSize: "var(--fs-xs)" }}>{cur ? `v${cur.version} · ${fmtTime(cur.savedAt)}` : "保存点"}</span>
        <span style={{ fontSize: 9, color: "var(--muted)", transform: open ? "rotate(180deg)" : "none", transition: "transform .15s" }}>▼</span>
      </button>
      {open && (
        <div className="snap-menu">
          {options.map((v, i) => {
            const key = `${v.version}@${v.savedAt}`;
            return (
              <button
                key={key}
                type="button"
                className={`snap-item${key === value ? " sel" : ""}`}
                onClick={() => {
                  setOpen(false);
                  onPick(v.version, v.savedAt);
                }}
              >
                <span className="snap-ver">v{v.version}</span>
                <span>{fmtTime(v.savedAt)}</span>
                {i === 0 && <span className="snap-badge">最新</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
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
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // 「修改后的 skills」视图(备份浏览/恢复):live = 执行目录实时编辑,edits = 备份只读视图
  const [view, setView] = useState<"live" | "edits">("live");
  const [edits, setEdits] = useState<EditGroup[] | null>(null); // null=未加载(进 edits tab 时拉)
  const [editSelected, setEditSelected] = useState<string | null>(null);
  const [editVersion, setEditVersion] = useState<string | null>(null);
  const [editSavedAt, setEditSavedAt] = useState(0);
  const [editContent, setEditContent] = useState("");
  const [restoringEdit, setRestoringEdit] = useState(false);
  const [confirmReq, setConfirmReq] = useState<ConfirmReq | null>(null);
  // 对比模式:拉执行目录实时内容,与选中备份并排 diff(左=备份 右=实时)
  const [diffMode, setDiffMode] = useState(false);
  const [disk, setDisk] = useState<{ rel: string; content: string } | null>(null);
  const [editMsg, setEditMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

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
  const selGroup = edits?.find((g) => g.rel === editSelected) ?? null; // 选中备份的分组(版本列表+stale)

  const doOpen = async (rel: string) => {
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

  const open = (rel: string) => {
    if (selected === rel) return;
    if (dirty) {
      setConfirmReq({
        title: "放弃未保存的修改?",
        body: `当前「${selected?.split("/")[0]}」有未保存的修改,切换后将丢失。`,
        okText: "放弃修改",
        danger: true,
        onOk: () => void doOpen(rel),
      });
      return;
    }
    void doOpen(rel);
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
        setSaving(false);
        setConfirmReq({
          title: "文件已被外部修改",
          body: "「" + (selected?.split("/")[0] ?? "") + "」在编辑期间被其他标签页/外部程序修改过,仍要用当前内容覆盖?",
          okText: "覆盖",
          danger: true,
          onOk: () => void doSave(true),
        });
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

  // to:提示写哪个视图的消息状态——live 工具栏渲染 msg、edits 工具栏渲染 editMsg,写错对象=无反馈
  const copyText = async (text: string, ok: string, err: string, to: "live" | "edits" = "live") => {
    // 局域网 IP 访问(非 localhost/非 https)时 navigator.clipboard 不可用 → 回退 textarea+execCommand
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const okc = document.execCommand("copy");
        document.body.removeChild(ta);
        if (!okc) throw new Error("execCommand copy failed");
      }
      const set = to === "edits" ? setEditMsg : setMsg;
      set({ kind: "ok", text: ok });
      setTimeout(() => set(null), 2500);
    } catch {
      (to === "edits" ? setEditMsg : setMsg)({ kind: "err", text: err });
    }
  };

  const copy = () => copyText(content, "已复制——可粘贴回仓库 skills/ 随下版发布", "复制失败,请手动全选复制");

  const askReset = () => {
    if (selected == null) return;
    setConfirmReq({
      title: "确认重置?",
      body: `将把「${selected.split("/")[0]}」恢复到首次编辑前的原始内容,当前修改会丢失。`,
      okText: "重置",
      danger: true,
      onOk: () => void resetNow(),
    });
  };

  const resetNow = async () => {
    if (selected == null) return;
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

  // ---- 「修改后的 skills」视图:备份列表加载 / 单备份读取 / 恢复到实时 ----

  const loadEdits = useCallback(() => {
    return api<{ edits: EditGroup[] }>("/api/skills/edits")
      .then((d) => setEdits(d.edits))
      .catch(() => setEdits([]));
  }, [api]);

  useEffect(() => {
    if (view === "edits") void loadEdits();
  }, [view, loadEdits]);

  // 默认打开最左侧备份;仅未选中时自动选(版本切换/恢复后的刷新不重置)
  useEffect(() => {
    if (view === "edits" && editSelected == null && edits?.length) void openEdit(edits[0]!.rel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, edits]);

  const openEdit = async (rel: string, version?: string, savedAt?: number) => {
    setEditMsg(null);
    try {
      const q =
        `rel=${encodeURIComponent(rel)}` +
        (version ? `&version=${encodeURIComponent(version)}` : "") +
        (savedAt ? `&savedAt=${savedAt}` : "");
      const c = await api<EditContent>(`/api/skills/edit?${q}`);
      setEditSelected(rel);
      setEditVersion(c.version);
      setEditSavedAt(c.savedAt);
      setEditContent(c.content);
      // 对比模式下切文件:同步换右侧实时内容
      if (diffMode && disk?.rel !== rel) void loadDisk(rel);
    } catch {
      setEditMsg({ kind: "err", text: "读取备份失败" });
    }
  };

  const loadDisk = async (rel: string): Promise<boolean> => {
    try {
      const f = await api<FileResponse>(`/api/skills/file?path=${encodeURIComponent(rel)}`);
      setDisk({ rel, content: f.content });
      return true;
    } catch {
      setEditMsg({ kind: "err", text: "实时目录中已无此文件(新版已删除?),无法对比" });
      return false;
    }
  };

  const toggleDiff = async () => {
    if (editSelected == null) return;
    if (diffMode) {
      setDiffMode(false);
      return;
    }
    if (!disk || disk.rel !== editSelected) {
      if (!(await loadDisk(editSelected))) return;
    }
    setDiffMode(true);
  };

  // 恢复到实时:先弹通用确认框,确认后 restoreNow 执行;实时视图有未保存修改时在文案里警示(会被丢弃)
  const restoreToLive = () => {
    if (editSelected == null || editVersion == null) return;
    setConfirmReq({
      title: "确认恢复到实时?",
      body:
        `将把「${editSelected.split("/")[0]}」v${editVersion}${editSavedAt ? ` · ${fmtTime(editSavedAt)}` : ""} 的快照写回执行目录,立即生效。当前磁盘内容(可能是升级后的新版)会被覆盖;恢复本身也会落一条新备份,可再次「重置」。` +
        (dirty ? "⚠ 实时视图当前有未保存的修改,恢复后将被丢弃。" : ""),
      okText: "恢复",
      onOk: () => void restoreNow(),
    });
  };

  const restoreNow = async () => {
    if (editSelected == null || editVersion == null) return;
    setRestoringEdit(true);
    setEditMsg(null);
    try {
      const res = await fetch(base + "/api/skills/restore", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "content-type": "application/json" },
        body: JSON.stringify({ path: editSelected, version: editVersion, savedAt: editSavedAt || undefined }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string; restoredFrom?: string };
      if (!res.ok) throw new Error(j.error ?? String(res.status));
      await Promise.all([reload(), loadEdits()]);
      // 切回实时视图直接看到生效内容(open 有同文件短路,这里无条件重载)
      const f = await api<FileResponse>(`/api/skills/file?path=${encodeURIComponent(editSelected)}`);
      setSelected(editSelected);
      setContent(f.content);
      setLoaded(f.content);
      setFileMtime(f.mtimeMs);
      setPreview(false);
      setView("live");
      setMsg({ kind: "ok", text: `已把 v${j.restoredFrom ?? editVersion} 的备份写回 ${editSelected},立即生效` });
      setTimeout(() => setMsg(null), 3500);
    } catch (e) {
      setEditMsg({ kind: "err", text: e instanceof Error ? e.message : "恢复失败" });
    } finally {
      setRestoringEdit(false);
    }
  };

  const copyEdit = () => copyText(editContent, "已复制备份内容", "复制失败,请手动全选复制", "edits");

  // Ctrl+S / Cmd+S 保存(仅实时视图:edits 视图编辑器只读,保存不可见的实时文件会让人懵)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (view === "live" && selected && dirty && !saving) void doSave(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, selected, dirty, saving, content, fileMtime]);

  const downloadText = (text: string, rel: string) => {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = rel.split("/").pop() ?? "skill.md";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const download = () => {
    if (selected == null) return;
    downloadText(content, selected);
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
      {confirmReq && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}
          onClick={() => setConfirmReq(null)}
        >
          <div
            style={{ background: "var(--titlebar)", color: "var(--text)", border: "1px solid var(--border-light)", borderRadius: 8, padding: "20px 24px", maxWidth: 420, boxShadow: "0 20px 60px rgba(0,0,0,0.45)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>{confirmReq.title}</div>
            <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 18, lineHeight: 1.5 }}>{confirmReq.body}</div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" className="tool-btn" onClick={() => setConfirmReq(null)}>取消</button>
              <button
                type="button"
                className="tool-btn"
                style={confirmReq.danger
                  ? { background: "#ef4444", borderColor: "#ef4444", color: "#fff" }
                  : { background: "#4f8cff", borderColor: "#4f8cff", color: "#fff" }}
                onClick={() => {
                  const r = confirmReq;
                  setConfirmReq(null);
                  r.onOk();
                }}
              >
                {confirmReq.okText}
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="stats-view">
      <div className="panel-header">
        <h2>Skills</h2>
        {data && (
          <span className="field-hint" style={{ padding: 0 }}>
            v{data.version} · {data.files.length} 个文件 · {data.root}
          </span>
        )}
      </div>
      <div className="stats-body">
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", minHeight: 0, height: "100%" }}>
          {/* 视图切换:实时(执行目录,可编辑) / 修改后(备份留痕,只读+恢复) */}
          <div style={{ display: "flex", gap: 2, flex: "0 0 auto", borderBottom: "1px solid var(--border)" }}>
            <button type="button" className={`tab${view === "live" ? " active" : ""}`} onClick={() => setView("live")}>
              实时 skills
            </button>
            <button type="button" className={`tab${view === "edits" ? " active" : ""}`} onClick={() => setView("edits")}>
              修改后的 skills{edits?.length ? ` (${edits.length})` : ""}
            </button>
          </div>

          {view === "edits" ? (
          <>
            <div className="skill-tabs">
              <div className="skill-tab-scroll">
                {edits == null ? null : edits.map((g) => (
                  <button
                    key={g.rel}
                    type="button"
                    className={`tab${editSelected === g.rel ? " active" : ""}`}
                    onClick={() => void openEdit(g.rel)}
                    title={`${g.rel} · ${g.versions.length} 份备份(最新 v${g.versions[0]?.version ?? "?"})`}
                  >
                    {g.stale && <span className="skill-dot" title="执行目录与最新备份不一致">●</span>}
                    {g.rel.split("/")[0]}
                    <span style={{ color: "var(--muted)", fontSize: "var(--fs-xs)" }}>v{g.versions[0]?.version ?? "?"}</span>
                  </button>
                ))}
              </div>
              {editSelected != null && (
                <div className="skill-actions">
                  {editMsg && <span className={editMsg.kind === "ok" ? "field-ok" : "field-err"} style={{ fontSize: "var(--fs-xs)" }}>{editMsg.text}</span>}
                  {selGroup != null && selGroup.versions.length > 1 && (
                    <SnapshotMenu
                      value={editVersion && editSavedAt ? `${editVersion}@${editSavedAt}` : ""}
                      options={selGroup.versions}
                      onPick={(v, s) => void openEdit(editSelected, v, s)}
                    />
                  )}
                  <span className="field-hint" style={{ padding: 0 }}>
                    {selGroup?.versions[0] && selGroup.versions[0].version === editVersion && selGroup.versions[0].savedAt === editSavedAt
                      ? (selGroup.stale ? "已被覆盖(未生效)" : "与磁盘一致")
                      : "历史快照"}
                  </span>
                  <button type="button" className="tool-btn" onClick={() => void toggleDiff()} title="左=此备份,右=执行目录实时内容,差异高亮——升级后搬改动用">
                    {diffMode ? "退出对比" : "⇄ 对比实时"}
                  </button>
                  <button type="button" className="tool-btn" onClick={() => void copyEdit()} title="复制备份全文,可切回「实时 skills」粘贴">
                    复制
                  </button>
                  <button type="button" className="tool-btn" onClick={() => editSelected && downloadText(editContent, editSelected)}>
                    下载
                  </button>
                  <button
                    type="button"
                    className="tool-btn"
                    onClick={() => void restoreToLive()}
                    disabled={restoringEdit}
                    title="把这份备份写回执行目录(立即生效,当前磁盘内容被覆盖;恢复本身也落新备份)"
                    style={{ background: "#4f8cff", color: "#fff", borderColor: "#4f8cff" }}
                  >
                    {restoringEdit ? "恢复中…" : "⬇ 恢复到实时"}
                  </button>
                </div>
              )}
            </div>
            {edits == null ? (
              <div className="sum-empty" style={{ flex: 1 }}>加载中…</div>
            ) : edits.length === 0 ? (
              <div className="sum-empty" style={{ flex: 1 }}>
                暂无修改记录——在「实时 skills」编辑保存后,这里会出现备份。
              </div>
            ) : editSelected == null ? (
              <div className="sum-empty" style={{ flex: 1 }}>点击上方文件查看备份内容(只读)。</div>
            ) : diffMode && disk != null && disk.rel === editSelected ? (
              <>
                <div className="field-hint" style={{ padding: 0 }}>
                  对比:左 = 此备份(v{editVersion} · {fmtTime(editSavedAt)}) · 右 = 实时磁盘{selGroup?.stale ? "(有差异,见高亮)" : "(与最新备份一致)"}
                </div>
                <div style={{ flex: 1, minHeight: 0, borderRadius: 4, border: "1px solid rgba(127,127,127,0.35)", overflow: "hidden", display: "flex", flexDirection: "column" }}>
                  <DiffEditor original={editContent} modified={disk.content} />
                </div>
              </>
            ) : (
              <div style={{ flex: 1, minHeight: 0, borderRadius: 4, border: "1px solid rgba(127,127,127,0.35)", overflow: "hidden", display: "flex", flexDirection: "column" }}>
                <CodeEditor value={editContent} onChange={() => {}} readOnly />
              </div>
            )}
          </>
          ) : (
          <>
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
                <button type="button" className="tool-btn" onClick={askReset} disabled={resetting} title="恢复到首次编辑前的原始内容">
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
          </>
          )}
        </div>
      </div>
      </div>
    </>
  );
}
