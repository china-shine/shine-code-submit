// 禅道工时读取器:遍历 DATA_DIR/zenpilot/submitted/*.jsonl(提交流水,逐笔 append-only),
// 生成 WorklogEntry[] 供 buildReport 上报。无状态、不依赖 Store,风格对齐 transcript.ts/git.ts/lines.ts。
//
// 数据源:submitted/<date>.jsonl 由 skills zentao.ts 的 commit/amend/submit 在禅道 API
// 返回成功后逐行追加(daemon 视角只读)。相比旧方案(读 plan.json resolved 条目)的优势:
// ①逐笔镜像禅道记录——plan.json 同会话同任务只存一条,二次提交会顶替丢历史;
// ②只含真正提交成功的条目——plan.json 的 resolved 是"归属完成",提交失败/冷却时也会被误上报。
// 全量读所有日期文件(忽略 buildReport 的 since 增量水位),靠 tokenserver 端 PK upsert 幂等累积。
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../shared/paths";
import type { WorklogEntry } from "../shared/types";

const ZENPILOT_DIR = join(DATA_DIR, "zenpilot");
const SUBMITTED_DIR = join(ZENPILOT_DIR, "submitted");
const CONFIG_FILE = join(ZENPILOT_DIR, "config.json");

/** 读 zenpilot/config.json 的 url(禅道根地址);读不到/无 url 返回 null(前端不拼超链接)。 */
function readZentaoUrl(): string | null {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as { url?: unknown };
    return typeof cfg.url === "string" && cfg.url.trim() ? cfg.url.trim() : null;
  } catch {
    return null;
  }
}

interface SubmittedLine {
  ts?: unknown;
  date?: unknown;
  session?: unknown;
  cwd?: unknown;
  repo?: unknown;
  branch?: unknown;
  start?: unknown;
  end?: unknown;
  minutes?: unknown;
  hours?: unknown;
  task?: unknown;
  taskName?: unknown;
  project?: unknown;
  projectName?: unknown;
  work?: unknown;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** 解析单个 submitted/<date>.jsonl → WorklogEntry[];坏行跳过(不影响其余上报)。 */
function parseSubmittedFile(file: string, date: string, zentaoUrl: string | null): WorklogEntry[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: WorklogEntry[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (!line) continue;
    let o: SubmittedLine;
    try {
      o = JSON.parse(line) as SubmittedLine;
    } catch {
      continue; // 半行写入(crash 兜底)等坏行跳过
    }
    if (typeof o.task !== "number" || typeof o.hours !== "number") continue; // 必填缺损失效
    out.push({
      date: typeof o.date === "string" ? o.date : date, // 兜底用文件名日期
      sessionId: typeof o.session === "string" ? o.session : "",
      cwd: typeof o.cwd === "string" ? o.cwd : "",
      repo: str(o.repo),
      branch: str(o.branch),
      start: str(o.start),
      end: str(o.end),
      minutes: typeof o.minutes === "number" ? o.minutes : 0,
      hours: o.hours,
      taskId: o.task,
      taskName: str(o.taskName),
      projectId: typeof o.project === "number" ? o.project : null,
      projectName: str(o.projectName),
      work: str(o.work),
      status: "resolved",
      zentaoUrl,
      subId: `${date}:${i}`, // 行号即流水号:同日多笔各自成行,tokenserver PK 含 subId 不顶替
    });
  }
  return out;
}

/** 全量读取 submitted/*.jsonl → WorklogEntry[]。忽略 since(见文件头说明)。 */
export function collectWorklogs(): WorklogEntry[] {
  if (!existsSync(SUBMITTED_DIR)) return [];
  const zentaoUrl = readZentaoUrl();
  let files: string[];
  try {
    files = readdirSync(SUBMITTED_DIR).filter((f) => f.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
  const out: WorklogEntry[] = [];
  for (const f of files) {
    const date = f.slice(0, -".jsonl".length); // 文件名即日期(YYYY-MM-DD)
    out.push(...parseSubmittedFile(join(SUBMITTED_DIR, f), date, zentaoUrl));
  }
  return out;
}
