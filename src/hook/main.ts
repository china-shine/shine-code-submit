// Hook 入口（短命进程）：
//   1. 采集 env + stdin，补 cwd/sessionId/pid/eventId/timestamp/type
//   2. 原子落盘 spool（tmp+rename）—— 唯一必成功环节
//   3. 热转发 POST；连接失败才走故障路径（ensureDaemon：探测→认自己人→拉起→轮询 ready）→ 重读 token → 重试
//   全程失败静默，退出码恒为 0（绝不影响 Claude Code）。
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { ensureDirs, DATA_DIR, NOTICE_FILE } from "../shared/paths";
import { readToken } from "../shared/pidfile";
import { writeSpoolFile } from "../shared/spool";
import { BASE_URL, PUBLIC_BASE_URL, HOOK_POST_TIMEOUT_MS, SERVICE_VERSION } from "../shared/config";
import { ensureDaemon, openBrowser, spawnDaemon, stopDaemon } from "../shared/daemonctl";
import { spawn } from "node:child_process";
import { dirname, join, basename } from "node:path";
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
  // Stop | SubagentStop:不 block(Stop block 在 Claude Code 会显示 "Stop hook error",见 issue #34600,
  //   即使用 exit 0 + JSON decision:block 亦然——是 Claude Code 固定 UX,无法避免);仅 forkZenCollect 采集 session。
  //   note 记录靠 UserPromptSubmit 每轮提示词提醒 AI 自觉(不强制,但无 error 显示)。
  if (event.type === "Stop" || event.type === "SubagentStop") {
    try {
      forkZenCollect(event.cwd, stdinRaw);
    } catch {
      /* ignore */
    }
    // 升级提示:daemon 已被 autoUpdate 升到新版,但当前会话 hook 仍跑旧版(Claude Code 会话锁定版本,
    // 不能热切)→ 提示用户重启 Claude Code 生效。每轮 Stop 提示直到重启(重启后 daemon 版本重新等于
    // hook 版本,提示自然消失)。仅 daemon 严格新于 hook 才提示(避免反方向——hook 新 daemon 旧——误报)。
    try {
      const dv = await fetchHealthVersion();
      if (dv && isNewer(dv, SERVICE_VERSION)) {
        process.stdout.write(JSON.stringify({ systemMessage: `✨ shine-worklog 已升级到 v${dv}(当前会话仍跑 v${SERVICE_VERSION}),重启 Claude Code 后生效` }));
      }
    } catch {
      /* ignore */
    }
  }

  // UserPromptSubmit:每轮注入提示词,告诉 AI「本轮有代码改动就在响应完成时记 note」。
  // 纯提示词驱动(不 block、不读文件、无 30min 兜底);AI 据此在响应末尾自觉记(task 不确定记 -1)。
  if (event.type === "UserPromptSubmit") {
    try {
      detectAndRemind();
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
    // 清理非当前版本的旧 cache 目录:install/autoUpdate 升级时不再立即删(会话中删旧目录会让当前
    // Claude Code 会话的 hook 因旧目录消失而断 "Plugin directory does not exist");改到这里——
    // Claude Code 启动时新会话已锁定当前版本目录(installed_plugins 已指向最新),删 sibling 旧版本安全。
    try {
      const root = process.env.CLAUDE_PLUGIN_ROOT;
      if (root) {
        const verDir = basename(root);
        const parent = dirname(root); // .../plugins/cache/<marketplace>/<plugin>
        for (const name of readdirSync(parent)) {
          if (name === verDir || !/^\d+\.\d+\.\d+/.test(name)) continue; // 跳过当前版本 + 非 semver 目录
          const p = join(parent, name);
          try { if (statSync(p).isDirectory()) rmSync(p, { recursive: true, force: true }); } catch { /* Windows 占用/权限,留下次 */ }
        }
      }
    } catch { /* ignore */ }
    // 早采集 session(写 sessions.json):Stop hook 在响应结束才采集,note 在响应中段跑会读不到
    // sessions.json(新项目第一次必中)。SessionStart 先采集一次,让第一轮 note 能读到 session。
    try {
      forkZenCollect(event.cwd, stdinRaw);
    } catch {
      /* ignore */
    }
    const out: Record<string, unknown> = {};
    // 规则注入(给 Claude):所有 SessionStart source 都注入插件根 CLAUDE.md,教 AI 顺手 note(clear/compact 后重载)。
    // 注:plugin SessionStart 的 additionalContext 可能受官方 bug #16538 影响(未确认修复);不生效时 detectAndRemind 每轮注入的提示词会兜底。
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
    // 升级检测:仅当 hook 新于 daemon 时才重启 daemon(把旧 daemon 升到 hook 新版)。
    // ⚠️ 反方向绝不能动——daemon 新于 hook(即 autoUpdate 已升 daemon、但当前会话 hook 还是旧版)时,
    // 若 stopDaemon+spawnDaemon 会用旧 hook 版本把新 daemon 降级(反复降)。daemon 已是新版,等用户重启 Claude Code 让 hook 跟上即可。
    if (r.version && isNewer(SERVICE_VERSION, r.version)) {
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

/** GET daemon /api/health 拿 version(升级检测:daemon 新于 hook 说明 autoUpdate 升级了,提示用户重启)。 */
async function fetchHealthVersion(): Promise<string | null> {
  try {
    const r = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(2000) });
    const j = (await r.json().catch(() => ({}))) as { version?: string };
    return j.version ?? null;
  } catch {
    return null;
  }
}

/** semver:a 是否严格新于 b(x.y.z 逐段数值比较,非字符串字典序)。 */
function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
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

// ---------- 每轮提示 AI 完成后记 note（UserPromptSubmit 注入提示词）----------

/** UserPromptSubmit:每轮 stdout 注入 additionalContext,提示 AI「本轮有代码改动就在响应完成时记 note」。
 *  纯提示词驱动(不 block、不读文件、无未记兜底);AI 据此在响应末尾自觉记(task 不确定记 -1)。失败静默。 */
function detectAndRemind(): void {
  // note 命令用 plugin 绝对路径(CLAUDE_PLUGIN_ROOT),不依赖 cwd——任何项目/目录都能直接跑。
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  const zentao = root ? `${root}/skills/report/scripts/zentao.ts` : "skills/report/scripts/zentao.ts";
  const msg =
    `[shine-worklog] 本轮一旦有代码改动(新建/编辑/删除文件),响应结束前【必须】记工时 note,不得遗漏。完整命令(直接执行): bun "${zentao}" note --work "一句话:本轮核心成果" --task <禅道任务ID,不确定传 -1 或省略>。纯问答/无文件改动可不记。`;
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: msg } }),
  );
}

/** 读插件根 CLAUDE.md（规则源），SessionStart 注入 additionalContext 教 AI 顺手 note（插件级：所有装插件项目生效）。
 *  注:plugin SessionStart additionalContext 可能受官方 bug #16538 影响(未确认修复);不生效时 detectAndRemind 每轮注入的提示词会兜底。
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
