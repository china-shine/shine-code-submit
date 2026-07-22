// 报表/分级接口共享的聚合逻辑(从 server.ts buildReport 抽出)。
// 保证 /api/report、/api/projects(L1)、/api/sessions?cwd=(L2) 三者项目分组与 token/lines 口径完全一致。
// buildReport 复用这里的函数 → 上报链路零回归。
import type { ScannedSession } from "./claude-scan";
import { getGitUser, getGitRemote } from "./git";
import { getSessionLines, sumLines } from "./lines";
import type { Store } from "./store";
import type { LinesStat, ProjectSummary, ReportProject, ReportSession, SessionSummary, TokenUsage } from "../shared/types";

const ZERO_TOKEN: TokenUsage = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };

/** 解码 Claude 项目目录名 → 真实 cwd：':' '\' '/' 都被编码成 '-'。
 *  Windows 盘符 C--… → C:\…（其余 - → \）；无盘符时原样返回(posix 情形,少见)。 */
export function decodeProjectCwd(project: string): string {
  const m = /^([A-Za-z])--(.*)$/.exec(project);
  if (m && m[1] && m[2]) return `${m[1]}:\\${m[2].replace(/-/g, "\\")}`;
  return project;
}

/** 路径取末段作项目名(与 ui/lib/util.ts shortDir 一致)。 */
export function shortName(p: string): string {
  if (!p) return "";
  const t = p.replace(/[\\/]+$/, "");
  const i = Math.max(t.lastIndexOf("/"), t.lastIndexOf("\\"));
  return i >= 0 ? t.slice(i + 1) : t;
}

/** sessionId → 最新 hook SessionSummary(取首个=最新,store.sessions 按 last_active DESC)。
 *  消费方取 .cwd(groupScannedByCwd)或完整字段 eventCount/lastType(/api/sessions)。 */
export function buildHookCwdMap(hookSessions: SessionSummary[]): Map<string, SessionSummary> {
  const m = new Map<string, SessionSummary>();
  for (const s of hookSessions) if (!m.has(s.sessionId)) m.set(s.sessionId, s);
  return m;
}

/** 按 cwd 分组扫描结果(真实 cwd:hookCwd 的 .cwd 优先,无则解码项目名)。返回 Map 保持插入序。 */
export function groupScannedByCwd(scanned: ScannedSession[], hookCwd: Map<string, SessionSummary>): Map<string, ScannedSession[]> {
  const byCwd = new Map<string, ScannedSession[]>();
  for (const s of scanned) {
    const cwd = hookCwd.get(s.sessionId)?.cwd ?? s.cwd ?? decodeProjectCwd(s.project);
    const arr = byCwd.get(cwd);
    if (arr) arr.push(s);
    else byCwd.set(cwd, [s]);
  }
  return byCwd;
}

/** 累加 TokenUsage 列表(可 null/undefined)。 */
export function sumTokens(arr: (TokenUsage | null | undefined)[]): TokenUsage {
  const t: TokenUsage = { ...ZERO_TOKEN };
  for (const u of arr) {
    if (u) {
      t.input += u.input;
      t.output += u.output;
      t.cacheCreation += u.cacheCreation;
      t.cacheRead += u.cacheRead;
    }
  }
  return t;
}

/** 构建 L2 session 明细行(含 lines,走 getSessionLines 缓存)。 */
function toReportSession(s: ScannedSession, store: Store): ReportSession {
  return {
    sessionId: s.sessionId,
    lastActive: s.lastActivity,
    tokenTotal: s.tokenTotal,
    linesTotal: getSessionLines(store, s.sessionId, s.lastActivity),
    title: s.title,
    activeMs: s.activeMs,
  };
}

/** 构建完整项目(含 sessions[],/api/report 用)。git 异步取(有 5min 缓存)。 */
export async function buildProjectDetail(cwd: string, ss: ScannedSession[], store: Store): Promise<ReportProject> {
  const sessions = ss.map((s) => toReportSession(s, store));
  const [gitUser, gitRemote] = await Promise.all([getGitUser(cwd), getGitRemote(cwd)]);
  return {
    cwd,
    name: shortName(cwd),
    gitUser,
    gitRemote,
    sessionCount: ss.length,
    sessions,
    totalTokens: sumTokens(sessions.map((r) => r.tokenTotal)),
    totalLines: sumLines(sessions.map((r) => r.linesTotal)),
  };
}

/** 构建 L1 项目汇总行(无 sessions[],/api/projects 用)。token 从 scanned 累加,lines 走 getSessionLines 缓存。
 *  不做同名消歧(分页下需全局视角);项目表用 shortName + cwd 列区分。 */
export async function buildProjectSummary(cwd: string, ss: ScannedSession[], store: Store): Promise<ProjectSummary> {
  const linesTotals = ss.map((s) => getSessionLines(store, s.sessionId, s.lastActivity));
  const [gitUser, gitRemote] = await Promise.all([getGitUser(cwd), getGitRemote(cwd)]);
  return {
    cwd,
    name: shortName(cwd),
    gitUser,
    gitRemote,
    sessionCount: ss.length,
    totalTokens: sumTokens(ss.map((s) => s.tokenTotal)),
    totalLines: sumLines(linesTotals),
    lastActive: ss.reduce((m, s) => Math.max(m, s.lastActivity), 0),
  };
}
