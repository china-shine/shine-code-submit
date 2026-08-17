// 关键信号文件存储:DATA_DIR/signals/<编码项目>/<日期>/<sessionId>.json(按项目按日期)。
// 会话为合并单元(增量追加状态在会话内);日期 = 首个信号事件的本地日期——稳定不迁移,跨午夜会话留在开工日目录,
// API 按 lastAt(而非目录日期)过滤,不丢跨天活跃会话。
// 不入 SQLite:信号是"提取产物"而非统计事实源,文件形态可直接浏览/清理,也免去 schema 迁移。
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SIGNALS_DIR } from "../shared/paths";
import { encodeProject, dateISO } from "../shared/datetime";
import { emptySignals, parseSignalEvents, parseSignalsBlob, serializeSignals, type SessionSignals, type TurnSignal } from "./signals";

/** /api/signals 输出的会话级信号(turns 已并入 open;commits/taskSubjects 为全会话去重并集)。 */
export interface ApiSignalSession {
  sessionId: string;
  cwd: string | null;
  date: string; // 归属日期(目录名,= 首个信号事件日)
  firstAt: number;
  lastAt: number;
  aiTitle: string | null;
  awaySummaries: SessionSignals["awaySummaries"];
  turns: TurnSignal[];
  commits: string[];
  taskSubjects: string[];
  filesChanged: string[];
  toolUseCounts: Record<string, number>;
  linesAdded: number;
  linesRemoved: number;
}

function safeRead(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function projectDir(baseDir: string, projectId: string): string {
  return join(baseDir, projectId);
}

/** 找会话已有信号文件:扫项目目录下全部日期子目录;找不到 null。 */
function findSignalsFile(baseDir: string, projectId: string, sessionId: string): string | null {
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

/** 原子写(tmp+rename,同 spool.ts 风格):读者永不读半截 JSON。 */
function atomicWrite(p: string, content: string): void {
  mkdirSync(join(p, ".."), { recursive: true });
  const tmp = p + ".tmp";
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, p);
}

/** 消费者侧:父 transcript 每次增量消费后调用,维护会话信号文件。 */
export class SignalsStore {
  /** sessionId→信号文件路径缓存(值 null=已找过、不存在→下次直接回填)。 */
  private pathCache = new Map<string, string | null>();

  constructor(private baseDir: string = SIGNALS_DIR) {}

  /** 该会话是否已有信号文件(路径缓存优先,查过即缓存)。兜底全扫判断"要不要标脏回填"用。 */
  has(info: { sessionId: string; projectId: string }): boolean {
    const cached = this.pathCache.has(info.sessionId)
      ? this.pathCache.get(info.sessionId)!
      : findSignalsFile(this.baseDir, info.projectId, info.sessionId);
    this.pathCache.set(info.sessionId, cached);
    return cached !== null;
  }

  /** 无已有文件/损坏/截断 → 整文件回填一次(覆盖升级前的历史);否则增量合并新行。
   *  transcript 读不出且无旧状态 → 静默跳过(不写空文件)。 */
  update(info: { path: string; sessionId: string; projectId: string }, newLines: string, truncated: boolean): void {
    const cached = this.pathCache.has(info.sessionId)
      ? this.pathCache.get(info.sessionId)!
      : findSignalsFile(this.baseDir, info.projectId, info.sessionId);
    this.pathCache.set(info.sessionId, cached);

    let state: SessionSignals | null = cached ? parseSignalsBlob(safeRead(cached)) : null;
    if (!state || truncated) {
      const raw = safeRead(info.path);
      if (raw === null && !state) return; // transcript 已删且无旧信号:不写
      state = parseSignalEvents(raw ?? "", state ?? emptySignals());
      // 注意:回填重解析整个文件,toolUseCounts/turns 全量重建,不会翻倍
    } else if (newLines) {
      parseSignalEvents(newLines, state);
    } else {
      return; // 无新完整行(半写行等),状态不变,跳过重写
    }

    const target = join(projectDir(this.baseDir, info.projectId), dateISO(state.firstAt), info.sessionId + ".json");
    atomicWrite(target, serializeSignals(state));
    this.pathCache.set(info.sessionId, target);
  }
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}

function lastAtOf(st: SessionSignals): number {
  return Math.max(st.lastAt, st.turns.length ? st.turns[st.turns.length - 1]!.endMs : 0, st.open?.endMs ?? 0);
}

/** API 侧:按 cwd(+since / +sessionId)读信号文件。since 过滤两道:文件 mtime 粗筛 → lastAt 复核。 */
export function readSignalsForApi(
  opts: { cwd: string; since?: number; sessionId?: string },
  baseDir: string = SIGNALS_DIR,
): { sessions: ApiSignalSession[]; total: number } {
  const dir = projectDir(baseDir, encodeProject(opts.cwd));
  let subs: string[] = [];
  try {
    subs = readdirSync(dir);
  } catch {
    return { sessions: [], total: 0 }; // 项目无信号目录(从未提取)
  }
  const out: ApiSignalSession[] = [];
  for (const sub of subs) {
    let names: string[] = [];
    try {
      names = readdirSync(join(dir, sub));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const p = join(dir, sub, name);
      const sessionId = name.replace(/\.json$/, "");
      if (opts.sessionId && sessionId !== opts.sessionId) continue;
      if (opts.since && !opts.sessionId) {
        // mtime 粗筛(留 1min 余量,容忍写入时差);sessionId 精查不筛,精确定位优先
        try {
          if (statSync(p).mtimeMs < opts.since - 60_000) continue;
        } catch {
          continue;
        }
      }
      const st = parseSignalsBlob(safeRead(p));
      if (!st) continue;
      if (st.cwd && st.cwd !== opts.cwd) continue; // 同编码不同 cwd 碰撞:按文件内真实 cwd 精确过滤
      const lastAt = lastAtOf(st);
      if (opts.since && !opts.sessionId && lastAt < opts.since) continue;
      const turns = st.open ? [...st.turns, st.open] : st.turns;
      out.push({
        sessionId,
        cwd: st.cwd,
        date: sub,
        firstAt: st.firstAt,
        lastAt,
        aiTitle: st.aiTitle,
        awaySummaries: st.awaySummaries,
        turns,
        commits: dedupe(turns.flatMap((t) => t.commits)),
        taskSubjects: dedupe(turns.flatMap((t) => t.taskSubjects)),
        filesChanged: st.filesChanged,
        toolUseCounts: st.toolUseCounts,
        linesAdded: turns.reduce((a, t) => a + t.added, 0),
        linesRemoved: turns.reduce((a, t) => a + t.removed, 0),
      });
    }
  }
  out.sort((a, b) => b.lastAt - a.lastAt);
  return { sessions: out, total: out.length };
}
