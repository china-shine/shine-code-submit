// 关键信号文件存储:DATA_DIR/signals/<编码项目>/<日期>/<sessionId>.json(按项目按日期)。
// 会话为合并单元(增量追加状态在会话内);日期 = 首个信号事件的本地日期——稳定不迁移,跨午夜会话留在开工日目录,
// API 按 lastAt(而非目录日期)过滤,不丢跨天活跃会话。
// 不入 SQLite:信号是"提取产物"而非统计事实源,文件形态可直接浏览/清理,也免去 schema 迁移。
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SIGNALS_DIR } from "../shared/paths";
import { encodeProject, dateISO } from "../shared/datetime";
import { emptySignals, parseSignalEvents, parseSignalsBlob, serializeSignals, cleanAwayText, type SessionSignals, type TurnSignal } from "./signals";

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

export function safeRead(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

export function mtimeOf(p: string): number | null {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

/** 信号落后判定余量:正常链路 5s tick 内信号必然写到 ≥ transcript mtime-5s,超出即异常落后。 */
const STALE_SLACK_MS = 5_000;

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
export function atomicWrite(p: string, content: string): void {
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

  /** 该会话是否已有信号文件(路径缓存优先,查过即缓存)。 */
  has(info: { sessionId: string; projectId: string }): boolean {
    const cached = this.pathCache.has(info.sessionId)
      ? this.pathCache.get(info.sessionId)!
      : findSignalsFile(this.baseDir, info.projectId, info.sessionId);
    this.pathCache.set(info.sessionId, cached);
    return cached !== null;
  }

  /** 兜底全扫判断"要不要标脏":无信号文件,或信号文件落后于 transcript(consumeFile 先写库后写信号,
   *  两步之间 daemon 被杀 → offset 已推进/不脏/has 为 true,永不再消费;或被旧版无信号逻辑的
   *  daemon 消费过)→ 需要标脏让消费者全量重建自愈。 */
  needsConsume(info: { sessionId: string; projectId: string; transcriptMtimeMs: number }): boolean {
    if (!this.has(info)) return true;
    const cached = this.pathCache.get(info.sessionId)!;
    const sigM = mtimeOf(cached);
    return sigM === null || sigM < info.transcriptMtimeMs - STALE_SLACK_MS;
  }

  /** 无已有文件/损坏/截断 → 整文件回填一次(覆盖升级前的历史);否则增量合并新行。
   *  transcript 读不出且无旧状态 → 静默跳过(不写空文件)。 */
  update(info: { path: string; sessionId: string; projectId: string }, newLines: string, truncated: boolean): void {
    const cached = this.pathCache.has(info.sessionId)
      ? this.pathCache.get(info.sessionId)!
      : findSignalsFile(this.baseDir, info.projectId, info.sessionId);
    this.pathCache.set(info.sessionId, cached);

    let state: SessionSignals | null = cached ? parseSignalsBlob(safeRead(cached)) : null;
    // 回填:必须从空状态整文件重建——不能把旧 state 传进来(truncated 时旧状态与全量叠加会翻倍)
    const rebuild = (): boolean => {
      const raw = safeRead(info.path);
      if (raw === null) return false; // transcript 读不出:无旧状态不写空文件;有旧状态保留原样不动
      state = parseSignalEvents(raw, emptySignals());
      return true;
    };
    if (!state || truncated) {
      if (!rebuild()) return;
    } else if (newLines) {
      parseSignalEvents(newLines, state);
    } else {
      // 无新完整行:若信号文件落后于 transcript(上次消费在写库后、写信号前被杀 → 标脏自愈入口;
      // 半写行等正常场景信号与 transcript 同龄)→ 全量重建;否则状态未变,跳过重写
      const sigM = mtimeOf(cached!);
      const srcM = mtimeOf(info.path);
      if (sigM === null || srcM === null || sigM >= srcM - STALE_SLACK_MS) return;
      if (!rebuild()) return;
    }
    if (!state) return; // 上面三支要么 return 要么 state 已赋值,此行同时供 TS 收窄

    // 全空状态不落盘:0 字节 transcript(会话刚建文件)写空文件到"今天"目录,日后内容 firstAt 赋值
    // 落到真实日期目录 → 旧空文件残留,sessionId 精查会返回同 id 两条。空 → 等有内容再建。
    if (!state.turns.length && !state.open && !state.awaySummaries.length && !state.aiTitle && !state.cwd && !Object.keys(state.toolUseCounts).length) {
      return;
    }
    const target = join(projectDir(this.baseDir, info.projectId), dateISO(state.firstAt), info.sessionId + ".json");
    atomicWrite(target, serializeSignals(state));
    if (cached && target !== cached) {
      // 归属日期漂移(firstAt 后到才赋值):迁移到新目录后删旧文件,防同 sessionId 双文件
      try {
        rmSync(cached);
      } catch {
        /* 旧文件已不在,忽略 */
      }
    }
    this.pathCache.set(info.sessionId, target);
  }
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}

/** /api/signals 响应会话数上限(按 lastAt 倒序取最近,防 since=0 全量撑爆响应;/report 场景 since=当天0点远达不到)。 */
const MAX_API_SESSIONS = 200;

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
  const byId = new Map<string, ApiSignalSession>(); // sessionId→最新者:双文件(备份恢复/手工拷贝等外部来源)防重复返回
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
      const entry: ApiSignalSession = {
        sessionId,
        cwd: st.cwd,
        date: sub,
        firstAt: st.firstAt,
        lastAt,
        aiTitle: st.aiTitle,
        awaySummaries: st.awaySummaries.map((a) => ({ ...a, text: cleanAwayText(a.text) })), // 存量旧文件尾巴也在此清掉
        turns,
        commits: dedupe(turns.flatMap((t) => t.commits)),
        taskSubjects: dedupe(turns.flatMap((t) => t.taskSubjects)),
        filesChanged: st.filesChanged,
        toolUseCounts: st.toolUseCounts,
        linesAdded: turns.reduce((a, t) => a + t.added, 0),
        linesRemoved: turns.reduce((a, t) => a + t.removed, 0),
      };
      const prev = byId.get(sessionId);
      if (!prev || entry.lastAt >= prev.lastAt) byId.set(sessionId, entry); // 双文件取新鲜者
    }
  }
  const out = [...byId.values()];
  out.sort((a, b) => b.lastAt - a.lastAt);
  if (out.length > MAX_API_SESSIONS) out.length = MAX_API_SESSIONS;
  return { sessions: out, total: out.length };
}
