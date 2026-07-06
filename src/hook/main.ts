// Hook 入口（短命进程）：
//   1. 采集 env + stdin，补 cwd/sessionId/pid/eventId/timestamp/type
//   2. 原子落盘 spool（tmp+rename）—— 唯一必成功环节
//   3. 热转发 POST；连接失败才走故障路径（ensureDaemon：探测→认自己人→拉起→轮询 ready）→ 重读 token → 重试
//   全程失败静默，退出码恒为 0（绝不影响 Claude Code）。
import { ensureDirs } from "../shared/paths";
import { readToken } from "../shared/pidfile";
import { writeSpoolFile } from "../shared/spool";
import { BASE_URL, HOOK_POST_TIMEOUT_MS } from "../shared/config";
import { ensureDaemon } from "../shared/daemonctl";
import type { HookEvent, HookEventType } from "../shared/types";

const VALID_TYPES: HookEventType[] = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SubagentStop",
  "PreCompact",
  "SessionEnd",
];

main().catch(() => process.exit(0));

async function main(): Promise<void> {
  const event = await collect();
  if (!event) {
    process.stderr.write("[shine-code-submit-hook] collect failed: missing cwd/sessionId\n");
    return process.exit(0);
  }

  // 1. 落盘（必成功环节）。失败时写 stderr 告警（可被发现），仍退出码 0。
  try {
    ensureDirs();
    writeSpoolFile(event);
  } catch (err) {
    process.stderr.write(
      `[shine-code-submit-hook] spool write failed: ${safeMsg(err)}; event=${truncate(JSON.stringify(event))}\n`,
    );
    return process.exit(0);
  }

  // 2. 热转发 + 故障路径（永不抛出）
  try {
    await forward(event);
  } catch (err) {
    process.stderr.write(`[shine-code-submit-hook] forward failed: ${safeMsg(err)}\n`);
  }
  process.exit(0);
}

/** 采集：argv[1] 或 stdin.hook_event_name 作为 type；cwd=process.cwd()；sessionId 取 stdin.session_id。 */
async function collect(): Promise<HookEvent | null> {
  // 扫描 argv 找有效事件名：兼容「直接调 exe (argv[1])」与「bun run script.ts X (argv[2])」两种形式
  const typeArg = process.argv.slice(1).find((a) => VALID_TYPES.includes(a as HookEventType)) as
    | HookEventType
    | undefined;
  const payload = await readStdin();
  const obj = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};

  const type: HookEventType =
    typeArg && VALID_TYPES.includes(typeArg)
      ? typeArg
      : typeof obj.hook_event_name === "string" && VALID_TYPES.includes(obj.hook_event_name as HookEventType)
        ? (obj.hook_event_name as HookEventType)
        : "PostToolUse";

  const sessionId =
    (typeof obj.session_id === "string" && obj.session_id) ||
    process.env.CLAUDE_SESSION_ID ||
    "unknown";
  const cwd = process.cwd();
  if (!cwd) return null;

  return {
    eventId: crypto.randomUUID(),
    type,
    timestamp: Date.now(),
    cwd,
    sessionId,
    pid: process.pid,
    payload: obj,
  };
}

/** 读 stdin（带超时兜底，防止无管道时阻塞）。解析失败则保留原始文本。 */
async function readStdin(): Promise<unknown> {
  if (process.stdin.isTTY) return null;
  try {
    const text = await Promise.race([
      Bun.stdin.text(),
      new Promise<string>((r) => setTimeout(() => r(""), 800)),
    ]);
    if (!text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch {
      return { _raw: text };
    }
  } catch {
    return null;
  }
}

async function forward(event: HookEvent): Promise<void> {
  const token = readToken();
  const url = `${BASE_URL}/api/hook/${event.type}`;
  if (await postOnce(url, event, token)) return;
  // 热转发失败 → 故障路径
  await ensureDaemon();
  // 重读 token（拉起后 pid 文件已更新）
  await postOnce(url, event, readToken() ?? token);
}

async function postOnce(url: string, event: HookEvent, token: string | null): Promise<boolean> {
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(HOOK_POST_TIMEOUT_MS),
    });
    return true; // 到达 daemon 即视为成功（事件也已落盘，回捞兜底）
  } catch {
    return false;
  }
}

function safeMsg(v: unknown): string {
  return v instanceof Error ? `${v.name}: ${v.message}` : String(v);
}
function truncate(s: string): string {
  return s.length > 500 ? `${s.slice(0, 500)}...` : s;
}
