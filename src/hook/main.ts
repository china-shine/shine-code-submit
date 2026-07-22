// Hook 入口（短命进程）：
//   1. 采集 env + stdin，补 cwd/sessionId/pid/eventId/timestamp/type
//   2. 原子落盘 spool（tmp+rename）—— 唯一必成功环节
//   3. 热转发 POST；连接失败才走故障路径（ensureDaemon：探测→认自己人→拉起→轮询 ready）→ 重读 token → 重试
//   全程失败静默，退出码恒为 0（绝不影响 Claude Code）。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { ensureDirs, DATA_DIR, NOTICE_FILE } from "../shared/paths";
import { readToken } from "../shared/pidfile";
import { writeSpoolFile } from "../shared/spool";
import { BASE_URL, PUBLIC_BASE_URL, HOOK_POST_TIMEOUT_MS, SERVICE_VERSION } from "../shared/config";
import { ensureDaemon, openBrowser, spawnDaemon, stopDaemon } from "../shared/daemonctl";
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

  // 3. SessionStart 时给用户打印 UI 入口：stdout 输出 JSON，Claude Code 解析 systemMessage
  //    字段直接显示给用户（裸 stdout 只注入 assistant 当 context，用户不可见）。
  //    · 每次「打开/回到」Claude（source=startup 或 resume）都打链接——任何方式进入都能看到入口。
  //    · 不覆盖 clear/compact（会话中途的 /clear、/compact），避免中途刷屏。
  //    · 升级/首次时链接前带「✨ 已升级 vX / ✨ vX」（upgradeNotice，凭 NOTICE_FILE 版本差异，同版本不带）。
  //    · 读不到 token（daemon 未就绪）则静默跳过。
  if (event.type === "SessionStart") {
    const source = (event.payload as Record<string, unknown> | null | undefined)?.source;
    if (source === "startup" || source === "resume") {
      const token = readToken();
      if (token) {
        const note = upgradeNotice(); // 升级/首次→"✨ …\n"；同版本→""；顺带落 NOTICE_FILE
        const url = `${PUBLIC_BASE_URL}/ui?t=${token}`; // 网卡 IP：显示与打开浏览器用同一地址，局域网通用
        process.stdout.write(JSON.stringify({ systemMessage: `${note}Shine Dashboard: ${url}` }));
        // openBrowser(url); // 自动弹浏览器暂时关闭——链接仍作 systemMessage 打印,用户可点开
      }
    }
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
  const r = await postOnce(url, event, token);
  if (r.ok) {
    // 升级检测:daemon 版本旧 → 停旧启新(不等 ready;本次事件已入库 + 已落 spool,新 daemon 起来后回捞后续)
    if (r.version && r.version !== SERVICE_VERSION) {
      await stopDaemon();
      spawnDaemon();
    }
    return;
  }
  // 热转发失败 → 故障路径
  await ensureDaemon();
  // 重读 token(拉起后 pid 文件已更新)
  await postOnce(url, event, readToken() ?? token);
}

async function postOnce(url: string, event: HookEvent, token: string | null): Promise<{ ok: boolean; version?: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(HOOK_POST_TIMEOUT_MS),
    });
    const data = (await res.json().catch(() => ({}))) as { version?: string };
    return { ok: true, version: data.version }; // 到达 daemon 即视为成功(事件也已落盘,回捞兜底);顺带读 version
  } catch {
    return { ok: false };
  }
}

function safeMsg(v: unknown): string {
  return v instanceof Error ? `${v.name}: ${v.message}` : String(v);
}
function truncate(s: string): string {
  return s.length > 500 ? `${s.slice(0, 500)}...` : s;
}

/**
 * 升级提示：对比 NOTICE_FILE 记录的上次版本与当前 SERVICE_VERSION。
 * - 同版本 → ""（不提示）。
 * - 首次（无记录/损坏）→ "✨ shine-code-submit vX\n"（也显示一次 banner 露链接），并落当前版本。
 *   关键：没有这条的话，引入本功能的版本自身（如 1.1.3）无基线可比 → 永远静默，所有用户升上来都看不到提示。
 * - 版本变了（升级/降级）→ "✨ shine-code-submit 已升级到 vX（原 v旧）\n"，并更新记录（下次同版本不再提示）。
 * 全程容错：任何读写失败均返回 ""，绝不影响 hook。
 */
function upgradeNotice(): string {
  try {
    let last = "";
    try {
      last = (JSON.parse(readFileSync(NOTICE_FILE, "utf8")) as { version?: string }).version ?? "";
    } catch {
      /* 无文件/损坏：视为首次 */
    }
    if (last === SERVICE_VERSION) return "";
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(NOTICE_FILE, JSON.stringify({ version: SERVICE_VERSION }));
    } catch {
      /* 写失败：本次仍提示，下次启动再尝试记录 */
    }
    return last
      ? `✨ shine-code-submit 已升级到 v${SERVICE_VERSION}（原 v${last}）\n`
      : `✨ shine-code-submit v${SERVICE_VERSION}\n`; // 首次也显示（露链接），不再静默
  } catch {
    return "";
  }
}
