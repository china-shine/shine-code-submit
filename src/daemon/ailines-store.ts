// AI 行集合文件存储:DATA_DIR/ailines/<编码项目>/<日期>/<sessionId>.json(按项目按日期)。
// 行数统计(getSessionLines)与 AI 占比分子(getProjectAILines)的数据源——2026-08-17 从 events 表
// 彻底换源 transcript(events 已停用入库);生命周期模式复用 signals-store(回填/损坏重建/漂移删旧/落后自愈)。
// 回填必须整 session 重建(父+全部子代理文件):单文件增量无法还原跨文件的 tool_use→tool_result 配对。
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AILINES_DIR } from "../shared/paths";
import { encodeProject, dateISO } from "../shared/datetime";
import { normRelPath } from "./lines";
import { sessionTranscriptFiles } from "./transcript";
import { safeRead, mtimeOf, atomicWrite } from "./signals-store";
import { emptyAiLines, parseAiLinesEvents, parseAiLinesBlob, serializeAiLines, isEmptyAiLines, type AiLinesState } from "./ailines";

const STALE_SLACK_MS = 5_000; // 同 signals-store:落后判定余量

function projectDir(baseDir: string, projectId: string): string {
  return join(baseDir, projectId);
}

/** 找会话已有 ailines 文件:扫项目目录下全部日期子目录;找不到 null。 */
function findAiLinesFile(baseDir: string, projectId: string, sessionId: string): string | null {
  const dir = projectDir(baseDir, projectId);
  let subs: string[] = [];
  try {
    subs = readdirSync(dir);
  } catch {
    return null;
  }
  for (const sub of subs) {
    const p = join(dir, sub, sessionId + ".json");
    if (existsSync(p)) return p;
  }
  return null;
}

/** 消费者侧:transcript(父或子代理)增量消费后调用,维护会话 ailines 文件。 */
export class AiLinesStore {
  private pathCache = new Map<string, string | null>();

  constructor(private baseDir: string = AILINES_DIR) {}

  /** 兜底全扫判断"要不要标脏"(同 signals.needsConsume 语义,供父文件判定)。 */
  needsConsume(info: { sessionId: string; projectId: string; transcriptMtimeMs: number }): boolean {
    const cached = this.pathCache.has(info.sessionId)
      ? this.pathCache.get(info.sessionId)!
      : findAiLinesFile(this.baseDir, info.projectId, info.sessionId);
    this.pathCache.set(info.sessionId, cached);
    if (cached === null) return true;
    const m = mtimeOf(cached);
    return m === null || m < info.transcriptMtimeMs - STALE_SLACK_MS;
  }

  /** 增量合并新行;无文件/损坏/截断 → 整 session 重建(父+全部子代理文件,保 tool_result 配对完整)。
   *  info.path 传父 transcript 路径(子代理文件由 sessionTranscriptFiles 展开)。 */
  update(info: { parentPath: string; sessionId: string; projectId: string }, newLines: string, truncated: boolean, isParentFile: boolean): void {
    const cached = this.pathCache.has(info.sessionId)
      ? this.pathCache.get(info.sessionId)!
      : findAiLinesFile(this.baseDir, info.projectId, info.sessionId);
    this.pathCache.set(info.sessionId, cached);

    let state: AiLinesState | null = cached ? parseAiLinesBlob(safeRead(cached)) : null;
    // 整 session 重建:必须从空状态读全量(父+子代理)——单文件增量拼不出跨文件 pending 配对
    const rebuild = (): boolean => {
      const next = emptyAiLines();
      for (const f of sessionTranscriptFiles(info.parentPath)) {
        const raw = safeRead(f);
        if (raw !== null) parseAiLinesEvents(raw, next);
      }
      if (isEmptyAiLines(next) && !state) return false; // 全部读不出且无旧状态:不写空文件
      state = next;
      return true;
    };
    if (!state || truncated) {
      if (!rebuild()) return;
    } else if (newLines) {
      parseAiLinesEvents(newLines, state);
    } else {
      // 无新行:落后自愈判定(mtime 同 signals 语义);子代理文件无新行不触发(以父文件为准)
      if (!isParentFile) return;
      const stM = cached ? mtimeOf(cached) : null;
      const srcM = mtimeOf(info.parentPath);
      if (stM === null || srcM === null || stM >= srcM - STALE_SLACK_MS) return;
      if (!rebuild()) return;
    }
    if (!state) return;

    if (isEmptyAiLines(state)) return; // 全空不落盘(0 字节/纯沟通会话;有内容再建)
    const target = join(projectDir(this.baseDir, info.projectId), dateISO(state.firstAt), info.sessionId + ".json");
    atomicWrite(target, serializeAiLines(state));
    if (cached && target !== cached) {
      try {
        rmSync(cached); // 归属日期漂移:迁移后删旧,防同 sessionId 双文件
      } catch {
        /* 已不在,忽略 */
      }
    }
    this.pathCache.set(info.sessionId, target);
  }
}

/** 某会话的行数统计(lines.ts getSessionLines 数据源)。无文件/损坏返回 null(无数据≠零行)。
 *  projectId 来自 transcript_sessions(真实磁盘目录名,免编码碰撞)。 */
export function readSessionAiLines(projectId: string, sessionId: string, baseDir: string = AILINES_DIR): AiLinesState | null {
  const f = findAiLinesFile(baseDir, projectId, sessionId);
  if (!f) return null;
  return parseAiLinesBlob(safeRead(f));
}

/** 某项目的 AI 行集合全集(getProjectAILines 数据源):扫该项目全部日期目录,union aiAdded/aiDeleted。
 *  键为 normRelPath(cwd, 原始file_path),值为行内容 Set——与原 events 版返回形状一致。 */
export function readProjectAiLines(cwd: string, baseDir: string = AILINES_DIR): { added: Map<string, Set<string>>; deleted: Map<string, Set<string>> } {
  const dir = projectDir(baseDir, encodeProject(cwd));
  const added = new Map<string, Set<string>>();
  const deleted = new Map<string, Set<string>>();
  let subs: string[] = [];
  try {
    subs = readdirSync(dir);
  } catch {
    return { added, deleted };
  }
  const union = (target: Map<string, Set<string>>, rec: Record<string, string[]> | undefined): void => {
    if (!rec) return;
    for (const [fp, lines] of Object.entries(rec)) {
      const np = normRelPath(cwd, fp);
      let set = target.get(np);
      if (!set) target.set(np, (set = new Set<string>()));
      for (const l of lines) set.add(l);
    }
  };
  for (const sub of subs) {
    let names: string[] = [];
    try {
      names = readdirSync(join(dir, sub));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const st = parseAiLinesBlob(safeRead(join(dir, sub, name)));
      if (!st) continue;
      union(added, st.aiAdded);
      union(deleted, st.aiDeleted);
    }
  }
  return { added, deleted };
}
