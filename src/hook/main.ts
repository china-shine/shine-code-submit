// Hook 入口（短命进程）：
//   1. 采集 env + stdin，补 cwd/sessionId/pid/eventId/timestamp/type
//   2. 原子落盘 spool（tmp+rename）—— 唯一必成功环节
//   3. 热转发 POST；连接失败才走故障路径（ensureDaemon：探测→认自己人→拉起→轮询 ready）→ 重读 token → 重试
//   全程失败静默，退出码恒为 0（绝不影响 Claude Code）。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { ensureDirs, DATA_DIR, NOTICE_FILE } from "../shared/paths";
import { encodeProject, todayISO } from "../shared/datetime";
import { readToken } from "../shared/pidfile";
import { writeSpoolFile } from "../shared/spool";
import { BASE_URL, PUBLIC_BASE_URL, HOOK_POST_TIMEOUT_MS, SERVICE_VERSION } from "../shared/config";
import { ensureDaemon, openBrowser, spawnDaemon, stopDaemon } from "../shared/daemonctl";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  const collected = await collect();
  if (!collected) {
    process.stderr.write("[shine-worklog-hook] collect failed: missing cwd/sessionId\n");
    return process.exit(0);
  }
  const { event, stdinRaw } = collected;

  // 1. 落盘（必成功环节）。失败时写 stderr 告警（可被发现），仍退出码 0。
  try {
    ensureDirs();
    writeSpoolFile(event);
  } catch (err) {
    process.stderr.write(
      `[shine-worklog-hook] spool write failed: ${safeMsg(err)}; event=${truncate(JSON.stringify(event))}\n`,
    );
    return process.exit(0);
  }

  // 2. 热转发 + 故障路径（永不抛出）
  try {
    await forward(event);
  } catch (err) {
    process.stderr.write(`[shine-worklog-hook] forward failed: ${safeMsg(err)}\n`);
  }

  // 2.5 Stop 事件：fork ZenPilot collect（合并进来的禅道工时填报 skill），把同一份 stdin 转发给子进程。
  //     Claude Code 的 Stop 只把 stdin 喂给一个进程，故由本 hook 读一次后转发（不能在 hooks.json 挂两条 command）。
  //     detached + unref，不阻塞；失败一律吞掉，绝不影响 hook 退出码。
  // Stop | SubagentStop:不 block(避免 Claude Code "blocking error" 显示);仅 forkZenCollect 采集 session。
  // "对话结束记"改由 UserPromptSubmit(detectAndRemind)每轮提示,让 AI 在响应里自觉记,无需 block 强制。
  if (event.type === "Stop" || event.type === "SubagentStop") {
    try {
      forkZenCollect(event.cwd, stdinRaw);
    } catch {
      /* ignore */
    }
  }

  // 2.6 UserPromptSubmit：检测今日未记工时累积，≥阈值则 stdout 注入 additionalContext 提醒 AI 补 note。
  //     纯本地读 3 个 JSON（<10ms），不联网不 spawn；hook 注入不保证 AI 执行（靠 CLAUDE.md 规则兜底）。
  if (event.type === "UserPromptSubmit") {
    try {
      detectAndRemind(event);
    } catch {
      /* ignore */
    }
  }

  // 3. SessionStart 时给用户打印 UI 入口：stdout 输出 JSON，Claude Code 解析 systemMessage
  //    字段直接显示给用户（裸 stdout 只注入 assistant 当 context，用户不可见）。
  //    · 每次「打开/回到」Claude（source=startup 或 resume）都打链接——任何方式进入都能看到入口。
  //    · 不覆盖 clear/compact（会话中途的 /clear、/compact），避免中途刷屏。
  //    · 升级/首次时链接前带「✨ 已升级 vX / ✨ vX」（upgradeNotice，凭 NOTICE_FILE 版本差异，同版本不带）。
  //    · 读不到 token（daemon 未就绪）则静默跳过。
  if (event.type === "SessionStart") {
    const out: Record<string, unknown> = {};
    // 规则注入(给 Claude):所有 SessionStart source 都注入插件根 CLAUDE.md,教 AI 顺手 note(clear/compact 后重载)。
    // 注:plugin SessionStart 的 additionalContext 可能受官方 bug #16538 影响(未确认修复);不生效时由 detectAndRemind 自包含提醒兜底。
    const rule = readRule();
    if (rule) out.hookSpecificOutput = { hookEventName: "SessionStart", additionalContext: rule };
    // Dashboard 链接(给用户):仅 startup/resume(避免 clear/compact 刷屏)
    const source = (event.payload as Record<string, unknown> | null | undefined)?.source;
    if (source === "startup" || source === "resume") {
      const token = readToken();
      if (token) {
        const note = upgradeNotice(); // 升级/首次→"✨ …\n"；同版本→""；顺带落 NOTICE_FILE
        const url = `${PUBLIC_BASE_URL}/ui?t=${token}`; // 网卡 IP：显示与打开浏览器用同一地址，局域网通用
        out.systemMessage = `${note}Shine Dashboard: ${url}`;
      }
    }
    if (Object.keys(out).length) process.stdout.write(JSON.stringify(out));
  }
  process.exit(0);
}

/** 采集：argv[1] 或 stdin.hook_event_name 作为 type；cwd=process.cwd()；sessionId 取 stdin.session_id。
 *  返回事件 + 原始 stdin 文本（后者用于 Stop 时 fork ZenPilot collect 转发）。 */
async function collect(): Promise<{ event: HookEvent; stdinRaw: string } | null> {
  // 扫描 argv 找有效事件名：兼容「直接调 exe (argv[1])」与「bun run script.ts X (argv[2])」两种形式
  const typeArg = process.argv.slice(1).find((a) => VALID_TYPES.includes(a as HookEventType)) as
    | HookEventType
    | undefined;
  const { raw: stdinRaw, value: payload } = await readStdin();
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
    event: {
      eventId: crypto.randomUUID(),
      type,
      timestamp: Date.now(),
      cwd,
      sessionId,
      pid: process.pid,
      payload: obj,
    },
    stdinRaw,
  };
}

/** 读 stdin（带超时兜底，防止无管道时阻塞）。返回原始文本 + 解析值；解析失败保留原始文本。 */
async function readStdin(): Promise<{ raw: string; value: unknown }> {
  if (process.stdin.isTTY) return { raw: "", value: null };
  try {
    const raw = await Promise.race([
      Bun.stdin.text(),
      new Promise<string>((r) => setTimeout(() => r(""), 800)),
    ]);
    if (!raw.trim()) return { raw: "", value: null };
    try {
      return { raw, value: JSON.parse(raw) };
    } catch {
      return { raw, value: { _raw: raw } };
    }
  } catch {
    return { raw: "", value: null };
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
 * - 首次（无记录/损坏）→ "✨ shine-worklog vX\n"（也显示一次 banner 露链接），并落当前版本。
 *   关键：没有这条的话，引入本功能的版本自身（如 1.1.3）无基线可比 → 永远静默，所有用户升上来都看不到提示。
 * - 版本变了（升级/降级）→ "✨ shine-worklog 已升级到 vX（原 v旧）\n"，并更新记录（下次同版本不再提示）。
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
      ? `✨ shine-worklog 已升级到 v${SERVICE_VERSION}（原 v${last}）\n`
      : `✨ shine-worklog v${SERVICE_VERSION}\n`; // 首次也显示（露链接），不再静默
  } catch {
    return "";
  }
}

// ---------- ZenPilot（合并进来的禅道工时填报 skill）Stop hook fork ----------

/** 解析 skills/report/scripts/zentao.ts 绝对路径。CLAUDE_PLUGIN_ROOT 优先，回退相对 main.ts。 */
function resolveZenCollectScript(): string | null {
  const rel = join("skills", "report", "scripts", "zentao.ts");
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  if (root && existsSync(join(root, rel))) return join(root, rel);
  try {
    const here = dirname(fileURLToPath(import.meta.url)); // .../src/hook/
    const p = join(here, "..", "..", rel); // .../skills/report/scripts/zentao.ts
    if (existsSync(p)) return p;
  } catch {
    /* ignore */
  }
  return null;
}

/** Stop hook：detached fork zentao.ts collect，把同一份 stdin 转发给子进程。不阻塞、不抛。 */
function forkZenCollect(cwd: string, stdinRaw: string): void {
  const script = resolveZenCollectScript();
  if (!script) return; // skills 未部署（老版本/未装），静默跳过
  const bun = process.execPath; // 源码模式下 hook 由 bun 跑，即 bun 完整路径
  let child;
  try {
    child = spawn(bun, ["run", script, "collect", "--cwd", cwd], {
      stdio: ["pipe", "ignore", "ignore"],
      detached: true,
      windowsHide: true,
      cwd,
    });
  } catch {
    return; // spawn 失败（bun 缺失等），忽略
  }
  child.on("error", () => {
    /* ignore */
  });
  try {
    if (stdinRaw) child.stdin.write(stdinRaw); // 转发同一份 stdin payload
    child.stdin.end();
  } catch {
    /* ignore */
  }
  child.unref(); // 关键：不阻塞父进程退出
}

// ---------- ZenPilot 未记工时检测（UserPromptSubmit 提醒 AI 顺手 note）----------

// encodeProject/todayISO 见 src/shared/datetime.ts(此处 import);pad2 是 todayISO 内部依赖,不直接用

/** UserPromptSubmit：读本地 sessions/summary/submitted 算"未记 activeMinutes"，
 *  ≥30 分钟则 stdout 输出 additionalContext（JSON），Claude Code 注入为 system reminder 提醒 AI 补 note。
 *  AI note 后（新式带水位）uncovered→0，下轮不再提醒（水位推进自然止）。失败静默，绝不影响 hook。 */
function detectAndRemind(event: HookEvent): void {
  const cwd = event.cwd;
  if (!cwd) return;
  // base:每轮提示"本轮若有代码改动,响应结束前 note"(替代 Stop block,无 error 显示;AI 在响应里自觉记)
  let msg =
    "[shine-worklog] 本轮若有代码改动,响应结束前用 note 记一句话结论(--work \"一句话:本轮核心成果\" --task <禅道任务ID>);不确定 task/纯调试/纯问答跳过,不记空内容。";
  const projectDir = join(DATA_DIR, "zenpilot", "projects", encodeProject(cwd));
  const today = todayISO();
  const sessionsPath = join(projectDir, "sessions.json");
  const summaryPath = join(projectDir, `summary-${today}.json`);
  const submittedPath = join(projectDir, "submitted.json");
  if (!existsSync(sessionsPath)) return; // 还没采集过

  let sd: any;
  try {
    sd = JSON.parse(readFileSync(sessionsPath, "utf8"));
  } catch {
    return;
  }
  if (!sd || sd.date !== today || !Array.isArray(sd.sessions)) return;
  // 粗筛:无任何 session 活跃达阈值(30=THRESHOLD)就不可能产生 offender,跳过 summary/submitted 读取(省 UserPromptSubmit 热路径 IO)
  if (!sd.sessions.some((s: any) => (Number(s.activeMinutes) || 0) >= 30)) return;

  let notes: any[] = [];
  try {
    notes = JSON.parse(readFileSync(summaryPath, "utf8")) || [];
  } catch {
    /* [] */
  }
  const notesBySession = new Map<string, any[]>();
  for (const n of notes) {
    if (!n || typeof n.session !== "string") continue;
    const arr = notesBySession.get(n.session) ?? [];
    arr.push(n);
    notesBySession.set(n.session, arr);
  }

  let submittedAll: any = {};
  try {
    submittedAll = JSON.parse(readFileSync(submittedPath, "utf8")) || {};
  } catch {
    /* {} */
  }
  const submitted = submittedAll[today] || {};

  const THRESHOLD = 30; // 单 session 未记累计≥30 分钟才提醒(= CLAUDE.md「≥30 分钟」,改阈值两处同步)
  const offenders: Array<{ id: string; minutes: number; branch: string | null }> = [];
  let totalUnnoted = 0;
  for (const s of sd.sessions) {
    if (!s || typeof s.id !== "string") continue;
    const sNotes = notesBySession.get(s.id) || [];
    const sActive = Number(s.activeMinutes) || 0;
    const subMin = Number(submitted[s.id]?.minutes) || 0;
    // 新式 note（有 notedActiveMinutes）取最大水位；仅有老 note→视为全覆盖；无 note→0
    // 同 zentao.ts waterNotes 的有水位过滤(main.ts 零依赖隔离内联,水位策略调整两处同步)
    const newNotes = sNotes.filter((n: any) => typeof n.notedActiveMinutes === "number");
    let noteWatermark: number;
    if (newNotes.length > 0) {
      noteWatermark = Math.max(...newNotes.map((n: any) => Number(n.notedActiveMinutes) || 0));
    } else if (sNotes.length > 0) {
      noteWatermark = sActive; // 仅有老 note → 视为全覆盖，不打扰
    } else {
      noteWatermark = 0;
    }
    const covered = Math.max(subMin, noteWatermark);
    const uncovered = sActive - covered;
    if (uncovered >= THRESHOLD) {
      totalUnnoted += uncovered;
      offenders.push({ id: s.id, minutes: uncovered, branch: s.branch ?? null });
    }
  }

  // 每轮都输出 base(开头已设);≥30min 未记则追加未记信息(detectAndRemind 原兜底)
  if (totalUnnoted >= THRESHOLD && offenders.length > 0) {
    const lines = offenders.slice(0, 3).map((o) => `· 会话 ${o.id}（branch ${o.branch ?? "?"}）：约 ${o.minutes} 分钟`);
    msg += `\n另:检测到今日有约 ${totalUnnoted} 分钟工作未记入 summary：\n${lines.join("\n")}\n若刚完成一个功能模块,补记一条。`;
  }
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: msg } }),
  );
}

/** 本轮(Stop 前)是否有代码改动:本轮 = 最近一次"用户真实输入"(role:user 且非 tool_result)之后到末尾。
 *  在本轮里找 tool_use Edit/Write/MultiEdit。无代码改动(纯问答/讨论/审查)→ false(不 block 打扰);有→ true。 */
function lastTurnHasCodeChange(transcriptPath: string): boolean {
  try {
    const raw = readFileSync(transcriptPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());
    // 从后往前找最近"用户真实输入"(排除 tool_result,它也是 role:user 但是工具结果)
    let userIdx = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.message?.role !== "user") continue;
        const c = ev.message.content;
        const isToolResult = Array.isArray(c) && c.some((b: any) => b?.type === "tool_result");
        if (!isToolResult) {
          userIdx = i;
          break;
        }
      } catch {
        /* skip */
      }
    }
    // 本轮(userIdx 之后)找代码改动 tool_use
    for (let i = userIdx; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      const content = ev.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (b?.type === "tool_use" && (b.name === "Edit" || b.name === "Write" || b.name === "MultiEdit")) {
          return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** 读插件根 CLAUDE.md（规则源），SessionStart 注入 additionalContext 教 AI 顺手 note（插件级：所有装插件项目生效）。
 *  注:plugin SessionStart additionalContext 可能受官方 bug #16538 影响(未确认修复);不生效时由 detectAndRemind 自包含提醒兜底。
 *  CLAUDE_PLUGIN_ROOT 优先,回退相对 main.ts（src/hook → 插件根）。 */
function readRule(): string | null {
  const rel = "CLAUDE.md";
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  const candidates: string[] = [];
  if (root) candidates.push(join(root, rel));
  try {
    candidates.push(join(dirname(fileURLToPath(import.meta.url)), "..", "..", rel));
  } catch {
    /* ignore */
  }
  for (const p of candidates) {
    try {
      if (existsSync(p)) return readFileSync(p, "utf8").trim();
    } catch {
      /* ignore */
    }
  }
  return null;
}
