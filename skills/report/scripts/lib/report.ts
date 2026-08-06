/** 日报 / 周报:从禅道 efforts 汇总提交记录,渲染自包含 HTML(内联 CSS)落盘到 DATA_DIR/reports/。
 *  纯渲染层:gatherReport 装配数据 → renderReportHtml/Text 渲染 → writeReport 落盘。 */
import { readdirSync } from "node:fs";
import * as path from "node:path";
import { esc, writeText, loadJSON, isObj, pad2, DATA_DIR, ZENPILOT_HOME } from "./shared";
import { getCache, type Client } from "./client";

export function weekStart(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0=周日
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
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
  title: string;
  realname: string;
  dates: string[]; // 有数据的天,升序
  byDate: Record<string, Record<string, ReportRow>>; // date -> taskId(字符串) -> {hours, works[]}
  infoMap: Map<number, { taskName: string; projectName: string }>;
  zentaoUrl: string;
};

/** 装配日报/周报数据:从禅道 efforts 汇总日期范围内的提交记录(纯数据,不含渲染)。 */
async function gatherReport(client: Client, cfg: Record<string, any>, from: string, to: string): Promise<ReportData> {
  const cache = await getCache(client, cfg);
  const ids = new Set<number>(collectTaskIds(from, to));
  for (const t of cache.tasks) ids.add(t.id);
  const idList = [...ids];

  const effMap = new Map<number, any[]>(
    await Promise.all(idList.map(async (id): Promise<[number, any[]]> => {
      try { return [id, await client.myEfforts(id)]; } catch { return [id, []]; }
    })),
  );
  const infoMap = new Map<number, any>(
    await Promise.all(idList.map(async (id): Promise<[number, any]> => {
      try { return [id, await taskNameInfo(client, cache, id)]; } catch { return [id, { taskName: `#${id}`, projectName: "" }]; }
    })),
  );

  // 按日期分组:date -> taskId(字符串) -> {hours, works[]}
  const byDate: Record<string, Record<string, ReportRow>> = {};
  for (const id of idList) {
    for (const e of effMap.get(id) || []) {
      if (!e.date || e.date < from || e.date > to) continue;
      const day = (byDate[e.date] ??= {});
      const key = String(id);
      (day[key] ??= { hours: 0, works: [] as string[] });
      day[key].hours += e.consumed;
      if (e.work) day[key].works.push(e.work);
    }
  }

  let realname = cfg.account;
  try {
    realname = ((await client.get("/user")).profile || {}).realname || realname;
  } catch {}

  const dates = Object.keys(byDate).sort();
  const title = from === to ? `日报 ${from}` : `周报 ${from} ~ ${to}`;
  return { from, to, title, realname, dates, byDate, infoMap, zentaoUrl: cfg.url };
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

  /* Day header (weekly) */
  .day-head { display:flex; align-items:baseline; justify-content:space-between;
              margin:16px 0 0; padding-bottom:5px; border-bottom:2px solid var(--line-soft); }
  .day-head:first-child { margin-top:0; }
  .day-date { font-size:16px; font-weight:800; color:var(--ink); }
  .day-week { font-size:12.5px; color:var(--muted); margin-left:8px; font-weight:500; }
  .day-total { font-size:15px; font-weight:800; color:var(--accent); font-variant-numeric:tabular-nums; }

  /* Table */
  table { width:100%; border-collapse:collapse; font-size:14px; margin-top:8px; }
  thead th { background:#f8fafc; color:#475569; font-weight:600; font-size:13px; }
  th, td { border:1px solid var(--line); padding:8px 12px; text-align:left; vertical-align:top; }
  tbody tr:nth-child(even) { background:#fcfcfd; }
  td.hours, th.hours { text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums; font-weight:600; }
  .tid { color:#94a3b8; font-weight:400; font-size:13px; margin-left:4px; }
  .cell-proj { color:var(--ink); font-weight:700; }
  .cell-task { font-weight:700; color:var(--ink); text-decoration:none; }
  a.cell-task:hover { color:var(--accent); text-decoration:underline; }
  .cell-date { width:110px; white-space:nowrap; }
  tr.total td { font-weight:700; color:var(--accent); background:#f3f0ff; }

  /* Grand total (weekly) */
  .grand { margin:16px 0 0; padding:11px 18px; border-radius:12px;
           background:linear-gradient(135deg,#eef2ff,#faf5ff); border:1px solid #e0e7ff;
           display:flex; align-items:center; justify-content:space-between; }
  .grand-label { font-size:14px; color:#475569; font-weight:600; }
  .grand-num { font-size:24px; font-weight:800; color:var(--accent); font-variant-numeric:tabular-nums; }

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
    .task:hover { transform:none; box-shadow:none; }
  }
`;

/** 把多个 work(各自 "1. a\n2. b" 从1编号)的条目拆出,顺延重新编号成单列表(1..N 不重复)。
 *  一天内多次提交同任务时,日报/周报聚合后避免出现多个重复的 1./2.。 */
function renumberWorks(works: string[]): string {
  const items: string[] = [];
  for (const w of works) {
    for (const line of String(w).replace(/\r/g, "").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      items.push(t.replace(/^\d+\.\s*/, "")); // 去原 "数字. " 前缀,统一重新编号
    }
  }
  return items.map((it, i) => `${i + 1}. ${it}`).join("\n");
}

/** 把报告数据渲染成自包含 HTML(内联 CSS,无外部依赖)。 */
function renderReportHtml(d: ReportData): string {
  const daily = d.from === d.to;
  const dateText = daily ? d.from : `${d.from} ~ ${d.to}`;
  const reportType = daily ? "日报" : "周报";

  const TABLE_HEAD = daily
    ? `<table>\n<thead><tr><th>任务</th><th class="hours">工时</th><th>工作内容</th></tr></thead>\n<tbody>`
    : `<table>\n<thead><tr><th>任务</th><th class="cell-date">日期</th><th class="hours">工时</th><th>工作内容</th></tr></thead>\n<tbody>`;
  const taskRow = (id: string, r: ReportRow, dateCell = "", bg = ""): string => {
    const info = d.infoMap.get(Number(id));
    return `<tr${bg ? ` style="background:${bg}"` : ""}>${dateCell}<td><a class="cell-task" href="${d.zentaoUrl}/index.php?m=task&amp;f=view&amp;taskID=${id}" target="_blank" rel="noopener">${esc(info?.taskName)}</a><span class="tid">#${esc(id)}</span></td><td class="hours">${round1(r.hours)}h</td><td>${esc(renumberWorks(r.works)).replace(/\n/g, "<br>")}</td></tr>`;
  };

  let total = 0;
  let taskCount = 0;
  const projects = new Set<string>();
  let body = "";

  if (d.dates.length === 0) {
    body = `<div class="empty"><div class="empty-icon">📭</div><div class="empty-text">该范围内没有禅道提交记录</div></div>`;
  } else if (daily) {
    const day = d.byDate[d.dates[0]];
    const rows: string[] = [];
    for (const id of Object.keys(day)) {
      total += day[id].hours; taskCount++;
      const info = d.infoMap.get(Number(id)); if (info?.projectName) projects.add(info.projectName);
      rows.push(taskRow(id, day[id]));
    }
    body = `${TABLE_HEAD}\n${rows.join("\n")}\n<tr class="total"><td>合计</td><td class="hours">${round1(total)}h</td><td>${taskCount} 个任务</td></tr>\n</tbody>\n</table>`;
  } else {
    // 按任务分组(同 taskId 聚一起),任务列用 rowspan 合并相同任务
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
    const rows: string[] = [];
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      const info = d.infoMap.get(g.id);
      g.rows.forEach((row, i) => {
        const taskCell = i === 0
          ? `<td${g.rows.length > 1 ? ` rowspan="${g.rows.length}"` : ""}><a class="cell-task" href="${d.zentaoUrl}/index.php?m=task&amp;f=view&amp;taskID=${g.id}" target="_blank" rel="noopener">${esc(info?.taskName)}</a><span class="tid">#${g.id}</span></td>`
          : "";
        rows.push(`<tr>${taskCell}<td class="cell-date">${esc(row.date.slice(5))}</td><td class="hours">${round1(row.r.hours)}h</td><td>${esc(renumberWorks(row.r.works)).replace(/\n/g, "<br>")}</td></tr>`);
      });
    }
    body = `${TABLE_HEAD}\n${rows.join("\n")}\n<tr class="total"><td colspan="2">本周合计</td><td class="hours">${round1(total)}h</td><td>${taskCount} 个任务</td></tr>\n</tbody>\n</table>`;
  }

  const statNum = d.dates.length === 0 ? "—" : `${round1(total)}h`;
  const chips = [
    `<span class="chip"><b>${taskCount}</b>个任务</span>`,
    `<span class="chip"><b>${projects.size}</b>个项目</span>`,
    daily ? "" : `<span class="chip"><b>${d.dates.length}</b>天</span>`,
  ].filter(Boolean).join("");
  const grand = ""; // 合计已在表尾行(周报单表含日期列)

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
${body}${grand}
    </div>
    <!--AI_SUMMARY-->
    <div class="foot">由 ZenPilot 自动生成 · ${esc(dateText)}</div>
  </div>
</body>
</html>`;
}

/** 精简纯文本摘要(供 stdout/对话速览,非落盘文件)。 */
function renderReportText(d: ReportData): string {
  const daily = d.from === d.to;
  if (d.dates.length === 0) return `${d.title} · ${d.realname}\n该范围内没有禅道提交记录。`;
  const line = (id: string, r: ReportRow): string => {
    const info = d.infoMap.get(Number(id));
    return `${info?.projectName ?? ""} / ${info?.taskName ?? ""} #${id}  ${round1(r.hours)}h  ${renumberWorks(r.works).replace(/\n/g, "; ")}`;
  };
  const lines: string[] = [`${d.title} · ${d.realname}`];
  let total = 0;
  if (daily) {
    const day = d.byDate[d.dates[0]];
    for (const id of Object.keys(day)) {
      total += day[id].hours;
      lines.push(line(id, day[id]));
    }
    lines.push(`合计 ${round1(total)}h · ${Object.keys(day).length} 个任务`);
  } else {
    for (const date of d.dates) {
      const day = d.byDate[date];
      const wd = WEEKDAYS[new Date(date + "T00:00:00").getDay()];
      for (const id of Object.keys(day)) {
        total += day[id].hours;
        lines.push(`[${date.slice(5)} ${wd}] ${line(id, day[id])}`);
      }
    }
    lines.push(`本周合计 ${round1(total)}h`);
  }
  return lines.join("\n");
}

/** 生成日报/周报 HTML 并落盘到 DATA_DIR/reports/(daemon 可稳定访问,dashboard 日报/周报模块查看),返回文件路径与文本摘要。 */
export async function writeReport(client: Client, cfg: Record<string, any>, from: string, to: string) {
  const data = await gatherReport(client, cfg, from, to);
  const html = renderReportHtml(data);
  const dir = path.join(DATA_DIR, "reports");
  const name = from === to ? `日报-${from}.html` : `周报-${from}~${to}.html`;
  const file = path.join(dir, name);
  writeText(file, html);
  return { ok: true, file, title: data.title, empty: data.dates.length === 0, text: renderReportText(data) };
}
