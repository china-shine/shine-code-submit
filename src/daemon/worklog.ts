// 禅道工时读取器:遍历 DATA_DIR/zenpilot/projects/*/plan.json,只取 status=resolved 的 items,
// 扁平化成 WorklogEntry[] 供 buildReport 上报。无状态、不依赖 Store,风格对齐 transcript.ts/git.ts/lines.ts。
//
// 数据源:plan.json 是 shine-worklog report skill 生成的「提交计划」,每个 item 含
// task/taskName/project/projectName/work/hours/date/status;status=resolved 表示已提交禅道。
// plan.json 单文件只存当天(每天 plan 覆盖),故 collectWorklogs 每次【全量】读所有项目 plan.json
// (忽略 buildReport 的 since 增量水位),靠 tokenserver 端 PK upsert 累积保留历史。
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../shared/paths";
import { decodeProjectCwd } from "./aggregate";
import type { WorklogEntry } from "../shared/types";

const ZENPILOT_DIR = join(DATA_DIR, "zenpilot");
const PROJECTS_DIR = join(ZENPILOT_DIR, "projects");
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

interface PlanItem {
  status?: unknown;
  session?: unknown;
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

/** 解析单个 plan.json → resolved WorklogEntry[]。plan 损坏/无 items 返回 [](不影响上报)。 */
function parsePlan(planPath: string, dir: string, zentaoUrl: string | null): WorklogEntry[] {
  let plan: { date?: unknown; items?: unknown[] };
  try {
    plan = JSON.parse(readFileSync(planPath, "utf8"));
  } catch {
    return [];
  }
  const date = typeof plan.date === "string" ? plan.date : "";
  const cwd = decodeProjectCwd(dir);
  const items: PlanItem[] = Array.isArray(plan.items) ? (plan.items as PlanItem[]) : [];
  const out: WorklogEntry[] = [];
  for (const o of items) {
    if (!o || o.status !== "resolved") continue; // 只上报已提交禅道的
    out.push({
      date,
      sessionId: typeof o.session === "string" ? o.session : "",
      cwd,
      repo: typeof o.repo === "string" ? o.repo : null,
      branch: typeof o.branch === "string" ? o.branch : null,
      start: typeof o.start === "string" ? o.start : null,
      end: typeof o.end === "string" ? o.end : null,
      minutes: typeof o.minutes === "number" ? o.minutes : 0,
      hours: typeof o.hours === "number" ? o.hours : 0,
      taskId: typeof o.task === "number" ? o.task : null,
      taskName: typeof o.taskName === "string" ? o.taskName : null,
      projectId: typeof o.project === "number" ? o.project : null,
      projectName: typeof o.projectName === "string" ? o.projectName : null,
      work: typeof o.work === "string" ? o.work : null,
      status: "resolved",
      zentaoUrl,
    });
  }
  return out;
}

/** 全量读取所有项目的 plan.json → resolved WorklogEntry[]。忽略 since(见文件头说明)。 */
export function collectWorklogs(): WorklogEntry[] {
  if (!existsSync(PROJECTS_DIR)) return [];
  const zentaoUrl = readZentaoUrl();
  let dirs: string[] = [];
  try {
    dirs = readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const out: WorklogEntry[] = [];
  for (const dir of dirs) {
    const planPath = join(PROJECTS_DIR, dir, "plan.json");
    if (!existsSync(planPath)) continue;
    out.push(...parsePlan(planPath, dir, zentaoUrl));
  }
  return out;
}
