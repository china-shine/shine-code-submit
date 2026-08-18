// Skills 文件编辑存储:定位当前生效插件根的 skills/ 目录 + 单文件读写 + 本地编辑备份。
// 备份 DATA_DIR/skills-edits/<version>/<base64url(rel)>.json——autoUpdate 升级 = 新目录整拷覆盖
// (deploy WHITELIST 含 skills,不保留用户改动),升级后磁盘内容与最后保存的编辑分叉 →
// /api/skills 标 stale 由前端提示手动恢复;不自动重放,避免静默覆盖新版改过的同名文件。
// 全同步 fs(文件均 <20KB,daemon 路由直调);写盘一律 tmp+rename 原子写(同 signals-store)。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "../shared/paths";
import { SERVICE_VERSION } from "../shared/config";

const EDITS_DIR = join(DATA_DIR, "skills-edits");
const MAX_DEPTH = 6;

/** 备份根目录 getter(供 server /api/skills/open-backup 打开与展示)。 */
export function editsDir(): string {
  return EDITS_DIR;
}
const MAX_BYTES = 1_048_576; // 1MB 上限:skills 实际文件均 <20KB,纯防御
// 只开放 markdown 编辑(SKILL.md 是 AI 的执行逻辑、改完即生效);.ts 代码走源码仓库改,不在 dashboard 动
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
  // 可读镜像 <version>/md/<rel>(纯 markdown 内容):「打开备份目录」后直接查看/拷贝;
  // 与顶层 base64url .json 隔离,listEdits 只扫顶层 *.json,镜像不进备份列表
  atomicWrite(join(EDITS_DIR, version, "md", rel), content);
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

/** 按 rel 分组全部编辑备份(跨版本,「修改后的 skills」tab 列表);stale 复用 computeStaleEdits。 */
export function listEditsGrouped(): EditGroup[] {
  const byRel = new Map<string, EditMeta[]>();
  for (const e of listEdits()) {
    const arr = byRel.get(e.rel);
    if (arr) arr.push(e);
    else byRel.set(e.rel, [e]);
  }
  const staleSet = new Set(computeStaleEdits().map((s) => s.rel));
  const out: EditGroup[] = [];
  for (const [rel, all] of byRel) {
    all.sort((a, b) => b.savedAt - a.savedAt);
    out.push({
      rel,
      versions: all.map((e) => ({ version: e.version, savedAt: e.savedAt })),
      stale: staleSet.has(rel),
    });
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

/** 读某 rel 的备份内容:默认最新,指定 version 则取该版本;无备份/损坏/缺 content → null。 */
export function getEditContent(rel: string, version?: string): EditContent | null {
  const all = listEdits().filter((e) => e.rel === rel && (!version || e.version === version));
  if (!all.length) return null;
  all.sort((a, b) => b.savedAt - a.savedAt);
  const meta = all[0]!;
  const blob = readBackup(meta.version, rel);
  if (!blob || typeof blob.content !== "string") return null;
  return { rel, version: meta.version, savedAt: meta.savedAt, content: blob.content };
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

/** 恢复编辑:把备份内容写回磁盘(默认该 rel 最新备份;version 指定则取该版本份)。
 *  恢复本身也落新备份 → hash 对齐 → 自动退出 stale。 */
export function restoreEdit(rel: string, version?: string): RestoreResult {
  const err = validateRelPath(rel);
  if (err) return { ok: false, error: err };
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

/** 重置:把文件恢复到首次编辑前的原始内容(备份 original 字段)。saveSkillFile 会继承 original 基线,重置可反复用。 */
export function resetEdit(rel: string): ResetResult {
  const err = validateRelPath(rel);
  if (err) return { ok: false, error: err };
  const meta = latestEditByRel().get(rel);
  if (!meta) return { ok: false, error: "该文件无编辑备份,无需重置" };
  let blob: EditBackup;
  try {
    blob = JSON.parse(readFileSync(backupPath(meta.version, rel), "utf8")) as EditBackup;
  } catch {
    return { ok: false, error: "备份文件损坏" };
  }
  if (typeof blob.original !== "string") return { ok: false, error: "该备份无原始基线(旧版备份),可手动改回" };
  const r = saveSkillFile(rel, blob.original);
  if (!r.ok) return r;
  return { ok: true, rel, size: r.size, mtimeMs: r.mtimeMs };
}
