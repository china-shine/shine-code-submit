// Skills 文件编辑存储:定位当前生效插件根的 skills/ 目录 + 单文件读写 + 本地编辑备份。
// 备份 DATA_DIR/skills-edits/<version>/<base64url(rel)>.json——autoUpdate 升级 = 新目录整拷覆盖
// (deploy WHITELIST 含 skills,不保留用户改动),升级后磁盘内容与最后保存的编辑分叉 →
// /api/skills 标 stale 由前端提示手动恢复;不自动重放,避免静默覆盖新版改过的同名文件。
// 全同步 fs(文件均 <20KB,daemon 路由直调);写盘一律 tmp+rename 原子写(同 signals-store)。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "../shared/paths";
import { SERVICE_VERSION } from "../shared/config";

const EDITS_DIR = join(DATA_DIR, "skills-edits");
const MAX_DEPTH = 6;
const MAX_BYTES = 1_048_576; // 1MB 上限:skills 实际文件均 <20KB,纯防御
// 只开放 markdown 编辑(SKILL.md 是 AI 的执行逻辑、改完落盘即时——skill 指令内容在 Claude Code 新会话生效);.ts 代码走源码仓库改,不在 dashboard 动
const EXT_RE = /\.md$/;
// 路径段形态白名单:字母/数字开头(挡 "." ".." 与隐藏文件),内容限常见安全字符
const SEG_RE = /^[A-Za-z0-9][A-Za-z0-9 ._\-()]{0,80}$/;
const VERSION_RE = /^[A-Za-z0-9._-]+$/;

/** skills 根:与 server.ts 定位 zentao.ts 同款相对解析——源码模式 src/daemon→仓库根/skills,
 *  编译模式 exe(bin/<plat>-<arch>)→插件根/skills。daemon 恒从"当前生效插件根"拉起
 *  (install 拉起/autoUpdate 升级后自动从新 cachePath 重启),故此处即 Claude Code 实际在读的目录。 */
export function skillsRoot(): string {
  return join(dirname(fileURLToPath(new URL(import.meta.url))), "..", "..", "skills");
}

/** 当前插件版本:读 <pluginRoot>/.install-version(deploy 写,格式 {version, installedAt});
 *  读不到 = 源码模式,回退 SERVICE_VERSION。daemon 不 import deploy.ts(install 层依赖)。 */
export function pluginVersion(): { version: string; sourceMode: boolean } {
  try {
    const raw = readFileSync(join(skillsRoot(), "..", ".install-version"), "utf8");
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    if (typeof v === "string" && v) return { version: v, sourceMode: false };
  } catch {
    /* 缺失/损坏 → 源码模式 */
  }
  return { version: SERVICE_VERSION, sourceMode: true };
}

export interface SkillFileMeta {
  rel: string;
  size: number;
  mtimeMs: number;
}

/** 绝对路径 → 相对 skills 根的 / 分隔路径(Windows \ 转 /)。 */
function relOf(p: string): string {
  return relative(skillsRoot(), p).split(sep).join("/");
}

/** 递归列 skills/ 下的 markdown 文件(深度≤6);根不存在返回空(前端用 root 字段展示原因)。 */
export function listSkillFiles(): SkillFileMeta[] {
  const out: SkillFileMeta[] = [];
  const walk = (dir: string, depth: number): void => {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth < MAX_DEPTH) walk(p, depth + 1);
      } else if (EXT_RE.test(name)) {
        out.push({ rel: relOf(p), size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  };
  walk(skillsRoot(), 0);
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}

/** 相对路径校验(第一道防线,形态白名单):1..6 段、每段 SEG_RE、扩展名白名单;返回错误文案或 null=通过。 */
export function validateRelPath(rel: string): string | null {
  if (rel.includes("\\") || rel.includes(":")) return "路径不得含反斜杠或盘符";
  const segs = rel.split("/");
  if (segs.length === 0 || segs.length > MAX_DEPTH) return "路径层级超限";
  if (segs.some((s) => !SEG_RE.test(s))) return "路径含非法段(.. 或非法字符)";
  if (!EXT_RE.test(rel)) return "仅支持编辑 Markdown 文件(.md)";
  return null;
}

/** 第二道防线:规范化后必须仍在 skills 根内;越界返回 null。 */
function resolveSkillPath(rel: string): string | null {
  const root = resolve(skillsRoot());
  const abs = resolve(root, rel);
  return abs.startsWith(root + sep) ? abs : null;
}

export function validateContent(content: string): string | null {
  if (Buffer.byteLength(content, "utf8") > MAX_BYTES) return "文件超过 1MB 上限";
  return null;
}

/** 读单文件;校验失败/不存在/不是普通文件 → null。 */
export function readSkillFile(rel: string): { content: string; size: number; mtimeMs: number } | null {
  const abs = resolveSkillPath(rel);
  if (!abs || !existsSync(abs)) return null;
  try {
    const st = statSync(abs);
    if (!st.isFile()) return null;
    return { content: readFileSync(abs, "utf8"), size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

// ---- 编辑备份(skills-edits) ----

interface EditBackup {
  rel: string;
  version: string; // 保存时所在插件版本(仅展示用,检测靠 hash)
  savedAt: number;
  hash: string; // sha1(content):与磁盘内容比对判分叉
  content: string;
  original?: string; // 首次编辑前的磁盘原始内容(初始化基线),供「重置」恢复;后续保存继承不改
}

export interface EditMeta {
  rel: string;
  version: string;
  savedAt: number;
  hash: string;
}

function sha1(s: string): string {
  return createHash("sha1").update(s, "utf8").digest("hex");
}

/** 原子写(tmp+rename,同 signals-store):读者永不读半截文件。 */
function atomicWrite(p: string, content: string): void {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, p);
}

/** 备份文件路径:<version>/<base64url(rel)>.json。base64url 无损规避 Windows 非法字符(/ \ : * ? " < > |),
 *  也不像 "__" 替换法有歧义碰撞(仓库真有 __tests__ 目录)。同 (version, rel) 重复保存 = 同名覆盖。 */
function backupPath(version: string, rel: string): string {
  const v = VERSION_RE.test(version) ? version : "_";
  return join(EDITS_DIR, v, Buffer.from(rel, "utf8").toString("base64url") + ".json");
}

function readBackup(version: string, rel: string): EditBackup | null {
  try {
    return JSON.parse(readFileSync(backupPath(version, rel), "utf8")) as EditBackup;
  } catch {
    return null;
  }
}

// ---- 保存历史:<version>/history/<b64url(rel)>.<savedAt>.json ----
// 同 (version,rel) 的备份 json 每次保存覆盖,中间状态不可回溯;内容有变的旧备份归档到 history,
// 留最近 MAX_HISTORY 份,「备份 skills」下拉可按 savedAt 取任意一次保存点。b64url 无 ".",
// 文件名按 "." 拆出 {rel, savedAt} 无歧义。

const MAX_HISTORY = 20;

function historyFile(version: string, rel: string, savedAt: number): string {
  return join(EDITS_DIR, version, "history", Buffer.from(rel, "utf8").toString("base64url") + "." + savedAt + ".json");
}

function pruneHistory(version: string, rel: string): void {
  const dir = join(EDITS_DIR, version, "history");
  const prefix = Buffer.from(rel, "utf8").toString("base64url") + ".";
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const mine = names
    .filter((n) => n.startsWith(prefix) && n.endsWith(".json"))
    .map((n) => ({ n, savedAt: Number(n.slice(prefix.length, -5)) }))
    .filter((x) => Number.isFinite(x.savedAt))
    .sort((a, b) => b.savedAt - a.savedAt);
  for (const x of mine.slice(MAX_HISTORY)) {
    try {
      unlinkSync(join(dir, x.n));
    } catch {
      /* ignore */
    }
  }
}

function writeEditBackup(rel: string, content: string): void {
  const { version } = pluginVersion();
  const prev = readBackup(version, rel);
  // original = 首次编辑前的原始内容:有旧备份则继承,否则读当前磁盘(saveSkillFile 先备份后写文件,此时磁盘仍是原始)
  let original = prev?.original;
  if (typeof original !== "string") {
    const cur = readSkillFile(rel);
    original = cur ? cur.content : content; // 首次即新建(文件不存在)时用 content 兜底
  }
  const blob: EditBackup = { rel, version, savedAt: Date.now(), hash: sha1(content), content, original };
  atomicWrite(backupPath(version, rel), JSON.stringify(blob, null, 2) + "\n");
  // 可读镜像 <version>/md/<rel>(纯 markdown 内容):备份 json 是 base64url 命名的包裹结构,
  // 镜像让磁盘上直接可读可拷;与顶层 .json 隔离,listEdits 只扫顶层 *.json,镜像不进备份列表
  atomicWrite(join(EDITS_DIR, version, "md", rel), content);
  // 保存历史:旧备份内容有变则归档(重复保存同内容不刷快照),随后修剪到 MAX_HISTORY 份
  if (prev && prev.hash !== blob.hash) {
    atomicWrite(historyFile(version, rel, prev.savedAt), JSON.stringify(prev));
  }
  pruneHistory(version, rel);
  pruneOldEditVersions();
}

/** 备份版本目录修剪:skills-edits/<version>/ 只保留最近 KEEP_VERSIONS 个——与 hook 清插件
 *  版本目录同口径(保留 5 个)。跨版本留痕本为升级覆盖后恢复用,插件目录自身只留 5 个版本,
 *  更老的备份已无对应磁盘,留着只随版本无限积累(~百 KB/版本)。保存时即时修剪;失败忽略下次再删。 */
const KEEP_VERSIONS = 5;
function pruneOldEditVersions(): void {
  let versions: string[];
  try {
    versions = readdirSync(EDITS_DIR).filter((n) => /^\d+\.\d+\.\d+$/.test(n));
  } catch {
    return;
  }
  versions.sort((a, b) => {
    const [aM = 0, am = 0, ap = 0] = a.split(".").map(Number);
    const [bM = 0, bm = 0, bp = 0] = b.split(".").map(Number);
    return bM - aM || bm - am || bp - ap; // 降序(新→旧)
  });
  for (const name of versions.slice(KEEP_VERSIONS)) {
    try { rmSync(join(EDITS_DIR, name), { recursive: true, force: true }); } catch { /* 占用/权限,留下次 */ }
  }
}

/** 全部编辑备份(仅 header,不含 content):扫 skills-edits 各版本目录下的备份 json,损坏跳过。 */
export function listEdits(): EditMeta[] {
  const out: EditMeta[] = [];
  let versions: string[] = [];
  try {
    versions = readdirSync(EDITS_DIR);
  } catch {
    return out;
  }
  for (const v of versions) {
    let names: string[] = [];
    try {
      names = readdirSync(join(EDITS_DIR, v));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const b = JSON.parse(readFileSync(join(EDITS_DIR, v, name), "utf8")) as Partial<EditBackup>;
        if (
          typeof b.rel === "string" && typeof b.version === "string" &&
          typeof b.savedAt === "number" && typeof b.hash === "string"
        ) {
          out.push({ rel: b.rel, version: b.version, savedAt: b.savedAt, hash: b.hash });
        }
      } catch {
        /* 损坏备份跳过 */
      }
    }
  }
  return out;
}

export interface EditGroup {
  rel: string;
  versions: Array<{ version: string; savedAt: number }>; // savedAt 降序
  stale: boolean; // 最新备份 hash ≠ 当前磁盘内容(可能被升级覆盖 / 外部手改)
}

/** 按 rel 分组全部编辑备份(跨版本 + history 快照,「备份 skills」tab 列表);stale 复用 computeStaleEdits。 */
export function listEditsGrouped(): EditGroup[] {
  const byRel = new Map<string, Array<{ version: string; savedAt: number }>>();
  const push = (rel: string, version: string, savedAt: number): void => {
    const arr = byRel.get(rel);
    if (arr) arr.push({ version, savedAt });
    else byRel.set(rel, [{ version, savedAt }]);
  };
  for (const e of listEdits()) push(e.rel, e.version, e.savedAt);
  // history 快照并入(savedAt 编码在文件名,免读全文解析)
  let versions: string[] = [];
  try {
    versions = readdirSync(EDITS_DIR);
  } catch {
    versions = [];
  }
  for (const v of versions) {
    let names: string[] = [];
    try {
      names = readdirSync(join(EDITS_DIR, v, "history"));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const parts = name.slice(0, -5).split(".");
      if (parts.length !== 2) continue;
      const rel = Buffer.from(parts[0]!, "base64url").toString("utf8");
      const savedAt = Number(parts[1]);
      if (!rel || !Number.isFinite(savedAt)) continue;
      push(rel, v, savedAt);
    }
  }
  const staleSet = new Set(computeStaleEdits().map((s) => s.rel));
  const out: EditGroup[] = [];
  for (const [rel, all] of byRel) {
    all.sort((a, b) => b.savedAt - a.savedAt);
    out.push({ rel, versions: all, stale: staleSet.has(rel) });
  }
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}

export interface EditContent {
  rel: string;
  version: string;
  savedAt: number;
  content: string;
}

/** 解析一份快照:默认最新(顶层);version 过滤版本;savedAt 精确定位某次保存(顶层命中直读,否则读 history 归档)。
 *  只给 savedAt 不给 version 时,快照可能在任意版本的 history 目录(跨版本升级留痕),依次扫各候选目录。 */
function resolveSnapshot(rel: string, version?: string, savedAt?: number): { version: string; blob: EditBackup } | null {
  const all = listEdits().filter((e) => e.rel === rel && (!version || e.version === version));
  if (!all.length) return null;
  all.sort((a, b) => b.savedAt - a.savedAt);
  const meta = all[0]!;
  if (typeof savedAt !== "number" || savedAt === meta.savedAt) {
    const blob = readBackup(meta.version, rel);
    return blob ? { version: meta.version, blob } : null;
  }
  const candidates = version ? [version] : [...new Set(all.map((e) => e.version))];
  for (const v of candidates) {
    try {
      const blob = JSON.parse(readFileSync(historyFile(v, rel, savedAt), "utf8")) as EditBackup;
      if (typeof blob.content === "string") return { version: v, blob };
    } catch {
      /* 该版本目录无此快照,继续 */
    }
  }
  return null;
}

/** 读某 rel 的备份内容:默认最新,version/savedAt 可定位任意一次保存;无备份/损坏/缺 content → null。 */
export function getEditContent(rel: string, version?: string, savedAt?: number): EditContent | null {
  const s = resolveSnapshot(rel, version, savedAt);
  return s && typeof s.blob.content === "string"
    ? { rel, version: s.version, savedAt: s.blob.savedAt, content: s.blob.content }
    : null;
}

/** rel → 最新一条备份(savedAt 最大)。 */
export function latestEditByRel(): Map<string, EditMeta> {
  const m = new Map<string, EditMeta>();
  for (const e of listEdits()) {
    const prev = m.get(e.rel);
    if (!prev || e.savedAt >= prev.savedAt) m.set(e.rel, e);
  }
  return m;
}

/** 分叉编辑:最新备份 hash ≠ 磁盘内容 sha1(文件被删也算)→ 可能被升级覆盖 / --force 重装 / 外部手改。 */
export function computeStaleEdits(): Array<{ rel: string; editVersion: string; savedAt: number }> {
  const out: Array<{ rel: string; editVersion: string; savedAt: number }> = [];
  for (const [rel, e] of latestEditByRel()) {
    const cur = readSkillFile(rel);
    if (!cur || sha1(cur.content) !== e.hash) out.push({ rel, editVersion: e.version, savedAt: e.savedAt });
  }
  out.sort((a, b) => b.savedAt - a.savedAt);
  return out;
}

export type SaveResult =
  | { ok: true; rel: string; size: number; mtimeMs: number; version: string }
  | { ok: false; error: string };

/** 保存:校验 → 先备份(目标写失败编辑也已留痕,不丢)→ 再原子写 skills/<rel>。 */
export function saveSkillFile(rel: string, content: string): SaveResult {
  const err = validateRelPath(rel);
  if (err) return { ok: false, error: err };
  const cerr = validateContent(content);
  if (cerr) return { ok: false, error: cerr };
  const abs = resolveSkillPath(rel);
  if (!abs) return { ok: false, error: "路径越出 skills 目录" };
  writeEditBackup(rel, content);
  atomicWrite(abs, content);
  try {
    const st = statSync(abs);
    return { ok: true, rel, size: st.size, mtimeMs: st.mtimeMs, version: pluginVersion().version };
  } catch {
    return { ok: true, rel, size: Buffer.byteLength(content, "utf8"), mtimeMs: 0, version: pluginVersion().version };
  }
}

export type RestoreResult =
  | { ok: true; rel: string; restoredFrom: string; size: number; mtimeMs: number }
  | { ok: false; error: string };

/** 恢复编辑:把备份内容写回磁盘(默认该 rel 最新备份;version/savedAt 可定位任意一次保存)。
 *  恢复本身也落新备份 → hash 对齐 → 自动退出 stale。 */
export function restoreEdit(rel: string, version?: string, savedAt?: number): RestoreResult {
  const err = validateRelPath(rel);
  if (err) return { ok: false, error: err };
  // 指定 savedAt:按快照解析(可能在 history 归档),不走"该版本最新"
  if (typeof savedAt === "number") {
    const s = resolveSnapshot(rel, version, savedAt);
    if (!s) return { ok: false, error: "该快照无备份" };
    const r = saveSkillFile(rel, s.blob.content);
    return r.ok ? { ok: true, rel, restoredFrom: s.version, size: r.size, mtimeMs: r.mtimeMs } : r;
  }
  const all = listEdits().filter((e) => e.rel === rel && (!version || e.version === version));
  if (!all.length) return { ok: false, error: "该文件无备份" };
  all.sort((a, b) => b.savedAt - a.savedAt);
  const meta = all[0]!;
  let blob: EditBackup;
  try {
    blob = JSON.parse(readFileSync(backupPath(meta.version, rel), "utf8")) as EditBackup;
  } catch {
    return { ok: false, error: "备份文件损坏" };
  }
  if (typeof blob.content !== "string") return { ok: false, error: "备份缺 content" };
  const r = saveSkillFile(rel, blob.content);
  if (!r.ok) return r;
  return { ok: true, rel, restoredFrom: meta.version, size: r.size, mtimeMs: r.mtimeMs };
}

export type ResetResult =
  | { ok: true; rel: string; size: number; mtimeMs: number }
  | { ok: false; error: string };

/** 重置:把文件恢复到**当前版本**首次编辑前的原始内容(备份 original 字段,saveSkillFile 继承基线可反复用)。
 *  只认当前版本的备份——升级换版本目录后新版本首存会从新磁盘重捕 original,旧版本的 original 不作重置来源,
 *  否则「升级后没在新版本编辑过就点重置」会把旧版内容写进新版磁盘,破坏「不修改=与版本一致」不变量
 *  (2026-08-18 定)。当前版本无备份=磁盘即出厂内容,明确报错;旧编辑走「备份 skills」恢复。 */
export function resetEdit(rel: string): ResetResult {
  const err = validateRelPath(rel);
  if (err) return { ok: false, error: err };
  const { version } = pluginVersion();
  const hasAny = latestEditByRel().has(rel);
  if (!hasAny) return { ok: false, error: "该文件无编辑备份,无需重置" };
  const cur = listEdits().some((e) => e.rel === rel && e.version === version);
  if (!cur) {
    return { ok: false, error: "当前版本未编辑过该文件——磁盘即出厂内容,无需重置;旧编辑在「备份 skills」里查看/恢复" };
  }
  let blob: EditBackup;
  try {
    blob = JSON.parse(readFileSync(backupPath(version, rel), "utf8")) as EditBackup;
  } catch {
    return { ok: false, error: "备份文件损坏" };
  }
  if (typeof blob.original !== "string") return { ok: false, error: "该备份无原始基线(旧版备份),可手动改回" };
  const r = saveSkillFile(rel, blob.original);
  if (!r.ok) return r;
  return { ok: true, rel, size: r.size, mtimeMs: r.mtimeMs };
}
