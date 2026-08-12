/** 会话采集 + transcript 解析。
 *  cmdCollect:读 shine-worklog daemon /api/sessions 映射成 shine-worklog session 写盘(hook/full 双模式)。
 *  extractTranscriptSignals:为 prepare 提取生成 work 所需的精选 transcript 信号。 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { DATA_DIR, PROJECT_CWD, SESSIONS_PATH, encodeProject, todayISO, localMidnightEpoch, writeJSON, num, countLines, extractText, localHHMM, gitBranchFallback } from "./shared";

// ---------- shine-worklog daemon 数据接入(合并后 collect 改读 daemon,不再挖 transcript) ----------

/** 读 shine-worklog daemon 的持久 token(复刻 src/shared/pidfile.ts readToken + paths.ts DATA_DIR,跨平台,零依赖)。 */
function readDaemonToken(): string | null {
  try {
    const pid = JSON.parse(readFileSync(path.join(DATA_DIR, "daemon.pid"), "utf8"));
    if (pid && typeof pid.token === "string" && pid.token) return pid.token;
  } catch {
    /* ignore */
  }
  try {
    const t = readFileSync(path.join(DATA_DIR, "daemon.token"), "utf8").trim();
    if (t.length >= 16) return t;
  } catch {
    /* ignore */
  }
  return null;
}

const DAEMON_BASE = "http://127.0.0.1:36666"; // config.ts BASE_URL,回环固定

/** 查 daemon 当天本项目 sessions(GET /api/sessions?cwd=&since=当日0点)。 */
async function fetchDaemonSessions(
  cwd: string,
  sinceMs: number,
  token: string,
): Promise<{ sessions: any[]; total: number }> {
  const url = `${DAEMON_BASE}/api/sessions?cwd=${encodeURIComponent(cwd)}&since=${sinceMs}&pageSize=200`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`daemon HTTP ${res.status}`);
  return (await res.json()) as { sessions: any[]; total: number };
}

/** daemon ProjectSession → shine-worklog session(字段映射见合并方案 2.1)。 */
export function toZenSession(s: any, branch: string | null): any {
  const activeMs = num(s.activeMs);
  const lastActive = num(s.lastActive);
  const tt = s.tokenTotal || {};
  const lt = s.linesTotal || { added: 0, deleted: 0, modified: 0 };
  return {
    id: s.sessionId,
    cwd: s.cwd || PROJECT_CWD,
    repo: path.basename(s.cwd || PROJECT_CWD),
    branch,
    start: localHHMM(Math.max(0, lastActive - activeMs)),
    end: localHHMM(lastActive),
    activeMinutes: Math.round(activeMs / 60000),
    tokens: { input: num(tt.input) + num(tt.cacheCreation) + num(tt.cacheRead), output: num(tt.output) },
    filesChanged: 0,
    linesAdded: num(lt.added) + num(lt.modified),
    linesRemoved: num(lt.deleted) + num(lt.modified),
    summary: typeof s.title === "string" && s.title ? s.title : "(无文本提示)",
  };
}

/** 解析 Claude transcript jsonl 成结构化信号(逐行 parse:user prompts + assistant texts + tool_use 的 files/行数/计数)。
 *  extractTranscriptSignals(prepare 热路径)用。未来 transcript 格式变更,改此处。返回 null=空/non-Claude 文件。 */
export function parseTranscriptEvents(raw: string): {
  prompts: string[];
  assistantTexts: string[];
  toolUseCounts: Record<string, number>;
  files: string[];
  added: number;
  removed: number;
} | null {
  const prompts: string[] = [];
  const assistantTexts: string[] = [];
  const toolUseCounts: Record<string, number> = {};
  const files = new Set<string>();
  let added = 0;
  let removed = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const role = ev.message?.role;
    if (role === "user") {
      const text = extractText(ev.message?.content).trim();
      if (text && !text.startsWith("<") && text.length > 1 && text.length <= 300) prompts.push(text);
    } else if (role === "assistant") {
      const content = ev.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (!b) continue;
        if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
          assistantTexts.push(b.text);
        } else if (b.type === "tool_use") {
          const name = b.name ?? "unknown";
          toolUseCounts[name] = (toolUseCounts[name] ?? 0) + 1;
          const input = b.input || {};
          if (typeof input.file_path === "string") files.add(input.file_path);
          if (b.name === "Edit") {
            added += countLines(input.new_string);
            removed += countLines(input.old_string);
          } else if (b.name === "Write") {
            added += countLines(input.content);
          } else if (b.name === "MultiEdit" && Array.isArray(input.edits)) {
            for (const e of input.edits) {
              added += countLines(e.new_string);
              removed += countLines(e.old_string);
            }
          }
        }
      }
    }
  }
  if (prompts.length === 0 && assistantTexts.length === 0 && Object.keys(toolUseCounts).length === 0) return null;
  return { prompts, assistantTexts, toolUseCounts, files: [...files], added, removed };
}

/** 为 prepare 提取生成 work 所需的精选 transcript 信号(不重算工时/token,那些 daemon 已给)。
 *  定位 ~/.claude/projects/<encodeProject(cwd)>/<sessionId>.jsonl,提取:
 *  前5条 prompts + 最近6条 assistant 文本(各≤500字) + toolUseCounts + 去重 filesChanged(前20) + 行数。
 *  文件不存在/空内容返回 null,调用方退化用 daemonSummary+candidates。解析走 parseTranscriptEvents。 */
export function extractTranscriptSignals(sessionId: string, cwd: string): any | null {
  const filePath = path.join(homedir(), ".claude", "projects", encodeProject(cwd), sessionId + ".jsonl");
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const parsed = parseTranscriptEvents(raw);
  if (!parsed) return null;
  const recentAssistantTexts = parsed.assistantTexts
    .slice(-6)
    .map((t: string) => (t.length > 500 ? t.slice(0, 500) : t)); // 最近的工作汇报:生成 work 的关键素材
  const filesChanged = parsed.files
    .map((f) => {
      const rel = path.relative(cwd, f); // 尽量转相对 cwd,便于阅读
      return rel && !rel.startsWith("..") ? rel : f;
    })
    .slice(0, 20);
  return {
    path: filePath,
    prompts: parsed.prompts.slice(0, 5),
    recentAssistantTexts,
    toolUseCounts: parsed.toolUseCounts,
    filesChanged,
    linesAdded: parsed.added,
    linesRemoved: parsed.removed,
  };
}

async function readStdinTimed(ms = 2000): Promise<string> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: string) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    const timer = setTimeout(() => finish(""), ms);
    Bun.stdin
      .text()
      .then((t) => {
        clearTimeout(timer);
        finish(t);
      })
      .catch(() => finish(""));
  });
}

export async function cmdCollect(): Promise<any> {
  // 合并后:collect 改读 shine-worklog daemon 的 /api/sessions(不再挖 transcript)。
  // hook 模式(Stop hook 触发,stdin 携带 payload)与 full 模式(/report 兜底手动跑)统一:
  //   读 daemon token → GET /api/sessions?cwd=本项目&since=当日0点 → 映射成 shine-worklog session → 写 sessions.json。
  // daemon 不可达时:hook 静默跳过(不写、不崩、不影响 hook);full 给错误提示。
  const isHook = process.stdin.isTTY !== true;
  let hookSessionId: string | null = null;
  if (isHook) {
    // hook 模式:读 stdin 仅取 session_id(日志/诊断用),不依赖其内容挖掘
    try {
      const text = await readStdinTimed();
      if (text.trim()) hookSessionId = JSON.parse(text)?.session_id ?? null;
    } catch {
      /* ignore */
    }
  }

  // 1. 读 daemon token
  const token = readDaemonToken();
  if (!token) {
    if (isHook) return { mode: "hook", skipped: "daemon token unavailable", hookSessionId };
    return { mode: "full", error: "daemon 未运行或 token 读不到(shine-worklog daemon 未启动)" };
  }

  // 2. 查 daemon 当天本项目 sessions
  let resp: { sessions: any[]; total: number };
  try {
    resp = await fetchDaemonSessions(PROJECT_CWD, localMidnightEpoch(), token);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (isHook) return { mode: "hook", skipped: "daemon fetch failed", error: msg, hookSessionId };
    return { mode: "full", error: `daemon 查询失败: ${msg}` };
  }

  // 3. branch 单值探测(daemon 不提供 branch,每 collect 调一次,所有 session 共用当前分支)
  const branch = gitBranchFallback(PROJECT_CWD);

  // 4. 映射 + 写盘(hook 仅在有数据时写,防 daemon 消费者 lag 误删;full 照实写含空)
  const sessions = resp.sessions.map((s: any) => toZenSession(s, branch));
  if (sessions.length > 0 || !isHook) {
    writeJSON(SESSIONS_PATH, { date: todayISO(), sessions });
  }

  return {
    mode: isHook ? "hook" : "full",
    date: todayISO(),
    count: sessions.length,
    hookSessionId,
    sessions: sessions.map((s: any) => ({ id: s.id, repo: s.repo, branch: s.branch, activeMinutes: s.activeMinutes })),
  };
}
