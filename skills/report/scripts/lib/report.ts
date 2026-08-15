/** 日报 / 周报:从禅道 efforts 汇总提交记录,渲染自包含 HTML(内联 CSS)落盘到 DATA_DIR/reports/。
 *  纯渲染层:gatherReport 装配数据 → renderReportHtml/Text 渲染 → writeReport 落盘。 */
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { esc, writeText, loadJSON, isObj, pad2, DATA_DIR, ZENPILOT_HOME, EFFORTS_DIR, loadMarkSetting, isAiWork, dashboardUrl, CACHE_PATH, SUBMITTED_LOG_DIR } from "./shared";
import { getCache, type Client } from "./client";

export function weekStart(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0=周日
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 上周区间 [周一, 周日](YYYY-MM-DD),供 /lastweek 一键生成上周周报。 */
export function lastWeekRange(): [string, string] {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0=周日
  const mondayThis = new Date(d);
  mondayThis.setDate(d.getDate() - (day === 0 ? 6 : day - 1)); // 本周一
  const sundayLast = new Date(mondayThis); sundayLast.setDate(mondayThis.getDate() - 1); // 上周日
  const mondayLast = new Date(mondayThis); mondayLast.setDate(mondayThis.getDate() - 7); // 上周一
  const fmt = (x: Date) => `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`;
  return [fmt(mondayLast), fmt(sundayLast)];
}

/** 收集日期范围内出现过的任务 ID(遍历所有项目的 submitted.json) */
function collectTaskIds(from: string, to: string): number[] {
  const root = path.join(ZENPILOT_HOME, "projects");
  const ids = new Set<number>();
  let projs: string[] = [];
  try {
    projs = readdirSync(root);
  } catch {
    return [];
  }
  for (const proj of projs) {
    const submitted = loadJSON<any>(path.join(root, proj, "submitted.json"), null);
    if (!submitted) continue;
    for (const date of Object.keys(submitted)) {
      if (date < from || date > to) continue;
      const day = submitted[date];
      if (!isObj(day)) continue;
      for (const key of Object.keys(day)) {
        if (key === "_meta") {
          for (const e of day._meta?.lastCommit || []) if (e.task) ids.add(e.task);
        } else {
          for (const tid of day[key]?.tasks || []) ids.add(tid);
        }
      }
    }
  }
  return [...ids];
}

/** 任务名 + 项目名(优先 cache,缺则 GET /tasks/{id}) */
async function taskNameInfo(client: Client, cache: any, taskId: number): Promise<{ taskName: string; projectName: string }> {
  const taskById: any = {};
  for (const t of cache.tasks) taskById[t.id] = t;
  let t = taskById[taskId] || cache.taskDetails?.[String(taskId)];
  if (!t) {
    try {
      const raw = await client.get(`/tasks/${taskId}`);
      const ex = raw.execution;
      const pid = isObj(ex) ? (ex as any).project : raw.project;
      t = { name: raw.name ?? null, project: pid ?? null };
    } catch {
      t = { name: null, project: null };
    }
  }
  const projectNames: any = {};
  for (const p of cache.projects) projectNames[p.id] = p.name;
  return { taskName: t.name ?? `#${taskId}`, projectName: projectNames[t.project] ?? "" };
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const round1 = (n: number) => Math.round(n * 10) / 10;

type ReportRow = { hours: number; works: string[] };
type ReportData = {
  from: string;
  to: string;
  daily: boolean; // true=日报(单天表格), false=周报(按任务分组+日期列);由 kind 显式决定,不靠 from===to 反推
  title: string;
  realname: string;
  dates: string[]; // 有数据的天,升序
  byDate: Record<string, Record<string, ReportRow>>; // date -> taskId(字符串) -> {hours, works[]}
  infoMap: Map<number, { taskName: string; projectName: string }>;
  zentaoUrl: string;
  aiHours: number; // 范围内 AI 代报(标识命中)的工时合计
  markText: string; // AI 标识文案:兼容历史换行格式记录(标识独立行时附尾、不单独编号);新括号格式行内不触发
  pendingTasks: { id: number; name: string; status: string | null; left: number; consumed: number; estimate: number; projectName: string }[];
};

/** 装配日报/周报数据:从禅道 efforts 汇总日期范围内的提交记录(纯数据,不含渲染)。 */
async function gatherReport(client: Client, cfg: Record<string, any>, from: string, to: string, kind?: "daily" | "weekly", source: "zentao" | "cache" = "zentao"): Promise<ReportData> {
  const cache = await getCache(client, cfg);
  const ids = new Set<number>(collectTaskIds(from, to));
  for (const t of cache.tasks) ids.add(t.id);
  const idList = [...ids];

  // 拉每个任务的 efforts。source=cache 读本地 efforts/ 目录(0 网络,refresh 快照,含已完成任务工时——
  // refresh 拉全状态任务);source=zentao 实时拉 client.myEfforts(准,联网)。
  // cache 源仍可能缺:已关闭执行里的任务/任务不指派给我的(靠实时源兜底)。
  let effMap: Map<number, any[]>;
  if (source === "cache") {
    effMap = new Map();
    try {
      for (const f of readdirSync(EFFORTS_DIR)) {
        if (!f.endsWith(".json")) continue;
        const e = loadJSON<any>(path.join(EFFORTS_DIR, f), null);
        if (e && e.taskId != null) effMap.set(e.taskId, e.efforts ?? []);
      }
    } catch { /* efforts/ 不存在 → effMap 空 */ }
  } else {
    effMap = new Map<number, any[]>(
      await Promise.all(idList.map(async (id): Promise<[number, any[]]> => {
        try { return [id, await client.myEfforts(id)]; } catch { return [id, []]; }
      })),
    );
  }
  const infoMap = new Map<number, any>(
    await Promise.all(idList.map(async (id): Promise<[number, any]> => {
      try { return [id, await taskNameInfo(client, cache, id)]; } catch { return [id, { taskName: `#${id}`, projectName: "" }]; }
    })),
  );

  // 按日期分组:date -> taskId(字符串) -> {hours, works[]}
  // work 存原文(含括号 AI 标识,渲染时作为内容一部分行内显示);同时按标识累计 aiHours 供对账展示
  const mark = loadMarkSetting();
  const byDate: Record<string, Record<string, ReportRow>> = {};
  let aiHours = 0;
  for (const id of idList) {
    for (const e of effMap.get(id) || []) {
      if (!e.date || e.date < from || e.date > to) continue;
      const day = (byDate[e.date] ??= {});
      const key = String(id);
      (day[key] ??= { hours: 0, works: [] as string[] });
      day[key].hours += e.consumed;
      if (e.work) {
        if (isAiWork(e.work, mark.text)) aiHours += e.consumed;
        day[key].works.push(e.work); // 保留原文(含括号标识),排版交给 AI(SKILL 流程)
      }
    }
  }

  let realname = cfg.account;
  try {
    realname = ((await client.get("/user")).profile || {}).realname || realname;
  } catch {}

  const dates = Object.keys(byDate).sort();
  // 报告类型由调用方显式传入;kind 缺省(测试/老调用)才回退 from===to。避免 /weekly 在周一(from===to)被误判成日报
  const daily = kind === "daily" ? true : kind === "weekly" ? false : from === to;
  const title = daily ? `日报 ${from}` : `周报 ${from} ~ ${to}`;
  // 未完成任务(禅道 doing/wait/pause,排除 done/closed/cancel)→ 供 AI 写「下周计划」(数据驱动,非主观推测)
  const projNames: Record<number, string> = {};
  for (const p of cache.projects) projNames[p.id] = p.name;
  const pendingTasks = (cache.tasks || [])
    .filter((t: any) => t.status !== "done" && t.status !== "closed" && t.status !== "cancel")
    .map((t: any) => ({
      id: t.id,
      name: t.name ?? `#${t.id}`,
      status: t.status ?? null,
      left: Number(t.left) || 0,
      consumed: Number(t.consumed) || 0,
      estimate: Number(t.estimate) || 0,
      projectName: projNames[t.project] ?? "",
    }));
  return { from, to, daily, title, realname, dates, byDate, infoMap, zentaoUrl: cfg.url, aiHours, markText: mark.text, pendingTasks };
}

const REPORT_CSS = `
  :root {
    --ink:#0f172a; --muted:#64748b; --line:#e2e8f0; --line-soft:#eef2f5;
    --accent:#4f46e5; --accent2:#7c3aed;
    --bg1:#eef2f7; --bg2:#f5f7fa;
  }
  * { box-sizing:border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", Roboto, sans-serif;
    color: var(--ink);
    background:#f5f7fa;
    margin:0; padding:0 16px 18px; line-height:1.6; font-weight:400;
    -webkit-font-smoothing: antialiased;
  }
  .report { width:95%; margin:0 auto; background:#fff; border-radius:18px; overflow:hidden;
            box-shadow:0 14px 44px rgba(15,23,42,.11); }

  /* Hero */
  .hero { position:relative; color:var(--ink); background:#fff;
          padding:18px 28px; display:flex; align-items:center; justify-content:space-between; gap:16px;
          border-bottom:3px solid var(--accent); }
  .hero-left { position:relative; z-index:1; display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; }
  .hero-stat { position:relative; z-index:1; }
  .hero-type { font-size:11.5px; letter-spacing:.22em; text-transform:uppercase; color:var(--accent); font-weight:600; }
  .hero-title { font-size:20px; font-weight:700; margin:0; letter-spacing:.01em; }
  .hero-sub { font-size:13px; color:var(--muted); }
  .hero-stat { text-align:right; }
  .hero-stat-num { font-size:28px; font-weight:700; line-height:1; font-variant-numeric:tabular-nums; color:var(--accent); }
  .hero-stat-label { font-size:12px; color:var(--muted); margin-top:5px; letter-spacing:.05em; }

  /* Meta chips */
  .meta { display:flex; gap:8px 20px; flex-wrap:wrap; padding:9px 28px;
          border-bottom:1px solid var(--line); background:#fafbfc; }
  .chip { font-size:13.5px; color:var(--muted); }
  .chip b { color:var(--ink); font-weight:700; font-variant-numeric:tabular-nums; margin-right:3px; }

  /* Body */
  .report-body { padding:12px 24px 16px; }

  /* Task collapsible(按任务折叠,默认收起;点击 summary 展开工作内容) */
  details.task { margin:8px 0; border:1px solid var(--line); border-radius:10px; overflow:hidden; background:#fff; transition:border-color .15s; }
  details.task:hover { border-color:#c7d2fe; }
  details.task > summary { list-style:none; cursor:pointer; padding:11px 16px; display:flex; align-items:center; gap:8px; font-weight:700; color:var(--ink); }
  details.task > summary::-webkit-details-marker { display:none; }
  details.task > summary::before { content:"▸"; color:var(--accent); font-size:12px; transition:transform .15s ease; display:inline-block; }
  details.task[open] > summary::before { transform:rotate(90deg); }
  details.task[open] > summary { border-bottom:1px solid var(--line-soft); }
  .task-summary .cell-task { font-size:14.5px; }
  .task-hours { margin-left:auto; color:var(--accent); font-variant-numeric:tabular-nums; font-size:14px; }
  .task-body { padding:10px 16px 12px 30px; font-size:13.5px; color:#334155; line-height:1.7; }
  .task-days .day-row { display:flex; gap:12px; padding:5px 0; align-items:baseline; border-bottom:1px dashed var(--line-soft); }
  .task-days .day-row:last-child { border-bottom:none; }
  .day-date { color:var(--muted); font-size:12.5px; min-width:46px; font-variant-numeric:tabular-nums; }
  .day-hours { color:var(--accent); font-weight:700; min-width:42px; font-variant-numeric:tabular-nums; }
  .day-works { flex:1; }

  .tid { color:#94a3b8; font-weight:400; font-size:13px; margin-left:4px; }
  .cell-task { font-weight:700; color:var(--ink); text-decoration:none; }
  a.cell-task:hover { color:var(--accent); text-decoration:underline; }

  /* total bar(合计) */
  .report-total { display:flex; align-items:center; gap:14px; margin:14px 0 0; padding:11px 16px; border-radius:10px;
                  background:linear-gradient(135deg,#eef2ff,#faf5ff); border:1px solid #e0e7ff; font-weight:700; }
  .report-total .total-num { font-size:20px; color:var(--accent); font-variant-numeric:tabular-nums; }
  .report-total .total-sub { margin-left:auto; color:var(--muted); font-weight:500; font-size:13px; }

  /* Empty */
  .empty { padding:56px 0; text-align:center; }
  .empty-icon { font-size:42px; margin-bottom:12px; opacity:.75; }
  .empty-text { color:var(--muted); font-size:14px; }

  /* AI summary */
  .ai-summary { margin:0; padding:18px 28px; border-top:1px solid var(--line); background:#fafbfc; }
  .ai-summary h2 { margin:0 0 10px; font-size:15px; font-weight:800; color:var(--ink); }
  .ai-summary h3 { margin:14px 0 6px; font-size:13.5px; font-weight:700; color:var(--ink); }
  .ai-summary p, .ai-summary li { font-size:13.5px; color:#475569; line-height:1.65; margin:4px 0; }
  .ai-summary ul { margin:4px 0; padding-left:20px; }

  /* Foot */
  .foot { padding:10px 28px; font-size:12.5px; color:var(--muted);
          border-top:1px solid var(--line); background:#fafbfc; }

  @media print {
    body { background:#fff; padding:0; }
    .report { box-shadow:none; max-width:none; border-radius:0; }
    .foot { display:none; }
    details.task { break-inside:avoid; }
    details.task > summary::before { content:""; }
    details.task > summary { border-bottom:none; }
    details.task .task-body { display:block !important; }
  }
`;

/** 把报告数据渲染成自包含 HTML(内联 CSS,无外部依赖)。 */
export function renderReportHtml(d: ReportData): string {
  const daily = d.daily ?? (d.from === d.to);
  const dateText = daily ? d.from : `${d.from} ~ ${d.to}`;
  const reportType = daily ? "日报" : "周报";

  // 任务折叠块 summary:任务名(禅道链接)+ #ID + 工时。<details> 默认折叠,点击 summary 展开工作内容
  const summary = (id: number, hours: number): string => {
    const info = d.infoMap.get(id);
    return `<summary class="task-summary"><a class="cell-task" href="${d.zentaoUrl}/index.php?m=task&amp;f=view&amp;taskID=${id}" target="_blank" rel="noopener">${esc(info?.taskName)}</a><span class="tid">#${id}</span><span class="task-hours">${round1(hours)}h</span></summary>`;
  };
  const worksHtml = (w: string[]): string => esc(w.join("\n").replace(/\r/g, "")).replace(/\n/g, "<br>"); // 原始 effort 逐条 <br> 分隔(去 \r),不排版——统一排版交给 AI

  let total = 0;
  let taskCount = 0;
  const projects = new Set<string>();
  let body = "";

  if (d.dates.length === 0) {
    body = `<div class="empty"><div class="empty-icon">📭</div><div class="empty-text">该范围内没有禅道提交记录</div></div>`;
  } else if (daily) {
    // 日报:每任务一个折叠块,默认收起,展开看工作内容
    const day = d.byDate[d.dates[0]];
    const blocks: string[] = [];
    for (const id of Object.keys(day)) {
      total += day[id].hours; taskCount++;
      const info = d.infoMap.get(Number(id)); if (info?.projectName) projects.add(info.projectName);
      blocks.push(`<details class="task">${summary(Number(id), day[id].hours)}<div class="task-body">${worksHtml(day[id].works)}</div></details>`);
    }
    body = `${blocks.join("\n")}\n<div class="report-total"><span>本日合计</span><span class="total-num">${round1(total)}h</span><span class="total-sub">${taskCount} 个任务</span></div>`;
  } else {
    // 周报:按任务分组,每任务一个折叠块,块内列各日期记录(日期 + 工时 + 工作内容)
    const groups: { id: number; rows: { date: string; r: ReportRow }[] }[] = [];
    const idxOf = new Map<number, number>();
    for (const date of d.dates) {
      const day = d.byDate[date];
      for (const id of Object.keys(day)) {
        const numId = Number(id);
        let gi = idxOf.get(numId);
        if (gi === undefined) { gi = groups.length; idxOf.set(numId, gi); groups.push({ id: numId, rows: [] }); }
        groups[gi].rows.push({ date, r: day[id] });
        total += day[id].hours;
        const info = d.infoMap.get(numId); if (info?.projectName) projects.add(info.projectName);
      }
    }
    taskCount = groups.length;
    const blocks: string[] = [];
    for (const g of groups) {
      const taskTotal = g.rows.reduce((s: number, row) => s + row.r.hours, 0);
      const dayRows = g.rows.map((row) =>
        `<div class="day-row"><span class="day-date">${esc(row.date.slice(5))}</span><span class="day-hours">${round1(row.r.hours)}h</span><div class="day-works">${worksHtml(row.r.works)}</div></div>`,
      ).join("");
      blocks.push(`<details class="task">${summary(g.id, taskTotal)}<div class="task-body"><div class="task-days">${dayRows}</div></div></details>`);
    }
    body = `${blocks.join("\n")}\n<div class="report-total"><span>本周合计</span><span class="total-num">${round1(total)}h</span><span class="total-sub">${taskCount} 个任务</span></div>`;
  }

  const statNum = d.dates.length === 0 ? "—" : `${round1(total)}h`;
  const chips = [
    `<span class="chip"><b>${taskCount}</b>个任务</span>`,
    `<span class="chip"><b>${projects.size}</b>个项目</span>`,
    daily ? "" : `<span class="chip"><b>${d.dates.length}</b>天</span>`,
    d.aiHours > 0 ? `<span class="chip"><b>${round1(d.aiHours)}h</b>AI 代报</span>` : "",
  ].filter(Boolean).join("");

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(d.title)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
  <div class="report">
    <div class="hero">
      <div class="hero-left">
        <span class="hero-type">${reportType}</span>
        <span class="hero-title">${esc(dateText)}</span>
        <span class="hero-sub">${esc(d.realname)}</span>
      </div>
      <div class="hero-stat">
        <div class="hero-stat-num">${statNum}</div>
        <div class="hero-stat-label">总工时</div>
      </div>
    </div>
    <div class="meta">${chips}</div>
    <div class="report-body">
${body}
    </div>
    <!--AI_SUMMARY-->
    <div class="foot">由 shine-worklog 自动生成 · ${esc(dateText)}</div>
  </div>
</body>
</html>`;
}

/** 精简纯文本摘要(供 stdout/对话速览,非落盘文件)。
 *  头行(日期+任务+工时)与工作内容分行:内容另起一行 4 空格缩进,确认时日期不被长 work 淹没。 */
export function renderReportText(d: ReportData): string {
  const daily = d.daily ?? (d.from === d.to);
  if (d.dates.length === 0) return `${d.title} · ${d.realname}\n该范围内没有禅道提交记录。`;
  const head = (id: string, r: ReportRow): string => {
    const info = d.infoMap.get(Number(id));
    return `${info?.projectName ?? ""} / ${info?.taskName ?? ""} #${id}  ${round1(r.hours)}h`;
  };
  const lines: string[] = [`${d.title} · ${d.realname}`];
  let total = 0;
  // 工作内容逐条一行(对齐 HTML 的 <br> 分行);effort 内部换行也拆行,统一 4 空格缩进
  const worksLines = (works: string[]): string[] =>
    works.flatMap((w) => w.replace(/\r/g, "").split("\n").map((l) => `    ${l}`));
  if (daily) {
    const day = d.byDate[d.dates[0]];
    for (const id of Object.keys(day)) {
      total += day[id].hours;
      lines.push(head(id, day[id]));
      lines.push(...worksLines(day[id].works)); // 原始 effort,不排版(AI 在 SKILL 流程统一排版)
    }
    lines.push(`合计 ${round1(total)}h · ${Object.keys(day).length} 个任务${d.aiHours > 0 ? `(其中 AI 代报 ${round1(d.aiHours)}h)` : ""}`);
  } else {
    for (const date of d.dates) {
      const day = d.byDate[date];
      const wd = WEEKDAYS[new Date(date + "T00:00:00").getDay()];
      for (const id of Object.keys(day)) {
        total += day[id].hours;
        lines.push(`[${date.slice(5)} ${wd}] ${head(id, day[id])}`);
        lines.push(...worksLines(day[id].works));
      }
    }
    lines.push(`本周合计 ${round1(total)}h${d.aiHours > 0 ? `(其中 AI 代报 ${round1(d.aiHours)}h)` : ""}`);
  }
  return lines.join("\n");
}

/** 日报/周报文件名:带归属人 realname,归档/分发时一眼区分谁的作品;去路径非法字符防意外。 */
export function reportFilename(from: string, to: string, realname: string, kind?: "daily" | "weekly"): string {
  const who = String(realname || "unknown").replace(/[\\/:*?"<>|]/g, "");
  // kind 显式优先(供 /weekly 在周一等 from===to 的场景强制周报);缺省回退 from===to
  const daily = kind === "daily" ? true : kind === "weekly" ? false : from === to;
  return daily ? `日报-${from}-${who}.html` : `周报-${from}~${to}-${who}.html`;
}

/** 缓存旧于区间内最后一笔提交 → true(报表侧据此先自动刷新再读)。
 *  比 cache.fetchedAt 与 submitted/<date>.jsonl 末行 ts(同 ISO 无时区格式,字符串可比)。
 *  仅检测自己工具的提交(手动在禅道页面录入的无法感知,靠实时源)。 */
function cacheStaleVsSubmissions(from: string, to: string): boolean {
  try {
    const cache = loadJSON<any>(CACHE_PATH, null);
    if (!cache?.fetchedAt) return false;
    let lastTs: string | null = null;
    for (let d = from; d <= to; ) { // 区间内逐日找最后一笔流水(文件按日,末行即最新)
      try {
        const lines = readFileSync(path.join(SUBMITTED_LOG_DIR, `${d}.jsonl`), "utf8").trimEnd().split("\n");
        const ts = lines.length ? (JSON.parse(lines[lines.length - 1])?.ts ?? null) : null;
        if (typeof ts === "string" && ts > (lastTs ?? "")) lastTs = ts;
      } catch { /* 当日无流水文件 */ }
      const dt = new Date(d + "T00:00:00");
      dt.setDate(dt.getDate() + 1);
      d = `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
    }
    return lastTs !== null && cache.fetchedAt < lastTs;
  } catch {
    return false;
  }
}

/** 生成日报/周报 HTML 并落盘到 DATA_DIR/reports/(daemon 可稳定访问,dashboard 日报/周报模块查看),返回文件路径与文本摘要。 */
export async function writeReport(client: Client, cfg: Record<string, any>, from: string, to: string, kind?: "daily" | "weekly", source: "zentao" | "cache" = "zentao") {
  // cache 源且缓存旧于区间内最后一笔提交 → 先同步刷新再读(提交后的笔立即进缓存,报表不缺数)。
  // 替代原「commit 后 detached spawn 刷新」方案——Windows 跨进程坑多(10-15 三次迭代:
  // unref 拖慢/ignore stdio 子进程被杀),同进程同步刷新零此类问题,代价仅 stale 时报表多几秒。
  let autoRefreshed = false;
  if (source === "cache" && cacheStaleVsSubmissions(from, to)) {
    await getCache(client, cfg, true);
    autoRefreshed = true;
  }
  const data = await gatherReport(client, cfg, from, to, kind, source);
  const html = renderReportHtml(data);
  const dir = path.join(DATA_DIR, "reports");
  const file = path.join(dir, reportFilename(from, to, data.realname, kind));
  writeText(file, html);
  return { ok: true, file, title: data.title, empty: data.dates.length === 0, text: renderReportText(data), pendingTasks: data.pendingTasks, dashboardUrl: dashboardUrl(), ...(autoRefreshed ? { autoRefreshed: true } : {}) };
}
