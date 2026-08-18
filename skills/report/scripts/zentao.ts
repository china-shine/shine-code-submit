#!/usr/bin/env bun
/** 禅道 REST API v1 客户端(shine-worklog 工时填报 skill 使用)— Bun + TypeScript 版。
 *
 * 命令(与原 zentao.py 一致,输出 JSON):
 *   config [--url U --account A --password P --projects 1,2] [--show]
 *   check / projects [--limit N] / my-tasks [--projects 1,2] [--all-status]
 *   executions [--projects 1,2] / create-task --execution ID --name TEXT --estimate H [--type devel --desc TEXT]
 *   refresh / plan / render / commit [--dry-run] / amend [--dry-run]
 *   efforts --task ID / submit --task ID --date D --hours H --work TEXT [--left H] [--dry-run] [--session S --minutes M]
 *   mark [--on|--off|--text T|--show]   # AI 提交标识开关与文案(存 settings.json,提交时拼到 work 末尾)
 *   learn --repo R --project P [--branch B --task T] / mappings [--forget-repo R]
 *
 * 配置文件 ~/.zenpilot/config.json:
 *   { "url": "https://...", "account": "...", "password": "...", "projectIds": [] }
 *
 * 模块拆分:常量/helper → ./lib/shared;禅道客户端+缓存 → ./lib/client;
 *   会话采集+transcript → ./lib/transcript;日报/周报 → ./lib/report。本文件只留命令实现 + 入口分发。 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { Args, die, loadJSON, writeJSON, roundPy, todayISO, nowISOSeconds, minutesSinceISO, hoursFromMinutes, fmtHours, isObj, loadConfig, loadMarkSetting, applyMark, requireStr, requireInt, summaryPathFor, CONFIG_PATH, CACHE_PATH, MAPPINGS_PATH, SETTINGS_PATH, SESSIONS_PATH, SUBMITTED_PATH, PLAN_PATH, PROJECT_DIR, PROJECT_CWD, SUBMITTED_LOG_DIR, COMMIT_COOLDOWN_MINUTES, lastSubmitSinceEpoch, num } from "./lib/shared";
import { Client, getCache, getCacheLocal } from "./lib/client";
import { cmdCollect, extractTranscriptSignals, fetchDaemonSignalsMap, fetchDaemonSignals } from "./lib/transcript";
import { writeReport, weekStart, lastWeekRange } from "./lib/report";

// ---------- 命令实现 ----------

function cmdConfig(a: Args): any {
  const cfg = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, "utf8")) : {};
  if (a.url !== undefined) cfg.url = String(a.url).replace(/\/+$/, "");
  if (a.account !== undefined) cfg.account = a.account;
  if (a.password !== undefined) cfg.password = a.password;
  if (a.projects !== undefined) {
    cfg.projectIds = String(a.projects)
      .split(",")
      .filter((x: string) => x.trim() !== "")
      .map((x: string) => parseInt(x, 10));
  }
  if (!a.show) {
    mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");
    chmodSync(CONFIG_PATH, 0o600);
  }
  const masked = { ...cfg };
  if (masked.password) masked.password = "***";
  return {
    path: CONFIG_PATH,
    config: masked,
    missing: ["url", "account", "password"].filter((k) => !cfg[k]),
  };
}

/** AI 提交标识设置(存 settings.json,不登录禅道):--on/--off 开关、--text 文案、--show 查看。
 *  无改动参数时只读;返回值恒为合并默认后的 {enabled,text}(loadMarkSetting)。 */
function cmdMark(a: Args): any {
  if (a.on || a.off || a.text !== undefined) {
    const settings = loadJSON<any>(SETTINGS_PATH, {});
    if (!isObj(settings.aiSubmitMark)) settings.aiSubmitMark = {};
    const m = settings.aiSubmitMark;
    if (a.on) m.enabled = true;
    if (a.off) m.enabled = false;
    if (a.text !== undefined) m.text = String(a.text);
    writeJSON(SETTINGS_PATH, settings);
  }
  return { path: SETTINGS_PATH, aiSubmitMark: loadMarkSetting() };
}

/** 有 notedActiveMinutes 水位的新式 note,按水位升序。
 *  cmdPlan summary 拆段 + increment 过滤共用(同文件真共享,消除水位 filter 散落)。 */
function waterNotes(notes: any[]): any[] {
  return notes
    .filter((n: any) => n && typeof n.notedActiveMinutes === "number")
    .sort((a: any, b: any) => (Number(a.notedActiveMinutes) || 0) - (Number(b.notedActiveMinutes) || 0));
}

/** 生成候选任务列表(repo→项目映射收窄候选,无映射=全部任务),供 needs_semantic / unmatched(task=-1) 给 AI 匹配。
 *  抽出原 cmdPlan needs_semantic 分支的候选构造,两处复用。 */
function candidatesFor(repo: string, mappings: any, tasks: any[], projectNames: Record<number, string>): any[] {
  const pid = mappings?.repoToProject ? mappings.repoToProject[repo] : undefined;
  return tasks
    .filter((t: any) => pid == null || t.project === pid)
    .map((t: any) => ({ id: t.id, name: t.name, project: t.project, projectName: projectNames[t.project] ?? null }));
}

// ---------- 元会话聚合(跑 /report//prepare//amend 本身产生的会话合并为一条工时) ----------
// 每次填报会新开 1-2 个 skill 调用会话,若逐条报(各 0.5h 下限)填报工时自我繁殖且时间段常重叠 →
// 按「同日同任务」聚合成一条:固定文案(消重复标题)+ 时间区间并集去重工时;commit 对各源会话记防重水位。

/** 填报系 skill 的路径段(daemon title=首条 user 消息含 skill 展开路径)。weekly/daily 报表会话不算(是正常工作)。 */
const META_SKILL_RE = /skills[\\/](report|prepare|amend)\b/;
/** 活跃超过此分钟数的会话不并入聚合:可能在 skill 会话里干了真开发(如 weekly 开头的主开发会话),双保险。 */
const META_MAX_MINUTES = 45;
const META_WORK = "执行 shine-worklog 工时填报流程";

function isMetaSkillSession(s: any): boolean {
  return META_SKILL_RE.test(String(s?.summary ?? "")) && num(s?.activeMinutes) < META_MAX_MINUTES;
}

/** "HH:MM" → 当日分钟数;不合法 → NaN。 */
export function hhmmToMin(v: unknown): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

export function minToHHMM(v: number): string {
  if (!Number.isFinite(v) || v < 0) return String(v);
  const h = Math.floor(v / 60);
  const m = Math.round(v % 60);
  return `${h < 10 ? "0" + h : h}:${m < 10 ? "0" + m : m}`;
}

/** 多个 [起,止] 分钟区间求并集:重叠/相邻段合并。返回 {total 总时长, first 最早起, last 最晚止}。 */
export function unionMinutes(spans: Array<[number, number]>): { total: number; first: number; last: number } {
  const sorted = spans.filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e)).sort((a, b) => a[0] - b[0]);
  if (sorted.length === 0) return { total: 0, first: NaN, last: NaN };
  let total = 0;
  let curEnd = -1; // -1 起步:首段也走「新段」分支正确累计(初始化为首段 end 会把首段时长丢掉)
  for (const [s, e] of sorted) {
    if (s > curEnd) {
      total += e - s; // 新段
      curEnd = e;
    } else if (e > curEnd) {
      total += e - curEnd; // 延伸既有段(重叠部分不重复计)
      curEnd = e;
    }
  }
  return { total, first: sorted[0]![0]!, last: Math.max(...sorted.map((x) => x[1]!)) };
}

/** 聚合 items 里的 meta 条目(非 already,含 needs_semantic——元会话无需 AI 归纳):同日同任务一组 →
 *  一条(固定文案/并集工时/sourceSessions 防重清单),插入组内首个成员的原位置、其余删除。
 *  already 的 meta 不动(已提交过);单个 meta 条目也规范化(统一文案+sourceSessions),保证文案稳定。 */
function aggregateMetaItems(items: any[]): any[] {
  const groupOf = new Map<any, string>(); // item 引用 → 组 key(成员摘出标记)
  const groups = new Map<string, any[]>();
  for (const it of items) {
    // already(已提交)/increment(增量,并集会把已提交时段重复计入)的 meta 不并入,保持原条目语义。
    // 组 key 只按日期(不含 task):同日元会话归属可能不同(有/无历史回退),分开会再裂成多条。
    if (!it.meta || it.status === "already" || it.increment) continue;
    const key = String(it.date);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(it);
    groupOf.set(it, key);
  }
  if (groups.size === 0) return items.slice(); // 副本:调用方会 items.length=0 重填,不能返回原引用
  const mergedByKey = new Map<string, any>();
  for (const [key, list] of groups) {
    const u = unionMinutes(list.map((it) => [hhmmToMin(it.start), hhmmToMin(it.end)]));
    const byEnd = [...list].sort((x, y) => String(y.end ?? "").localeCompare(String(x.end ?? "")));
    const latest = byEnd[0]!;
    // 组归属:最新会话的 task 优先,无效(-1)则组内任一有效 task(有历史回退的成员兜底),全无 → -1
    const groupTask =
      Number(latest.task) > 0 ? Number(latest.task) : (Number(list.find((it) => Number(it.task) > 0)?.task) || -1);
    mergedByKey.set(key, {
      ...list[0]!,
      session: latest.session, // 代表会话取组内最新(展示/流水)
      start: Number.isFinite(u.first) ? minToHHMM(u.first) : list[0]!.start,
      end: Number.isFinite(u.last) ? minToHHMM(u.last) : list[0]!.end,
      minutes: Math.max(...list.map((it) => num(it.minutes))), // 水位取组内最大
      hours: hoursFromMinutes(Math.max(u.total, 1)), // 并集去重后的真实活跃时长(≥1min 保 0.5h 下限)
      work: META_WORK,
      status: groupTask > 0 ? "resolved" : "unmatched", // 无历史归属的新项目:聚合后仍留 /report 问一次
      task: groupTask,
      increment: false,
      confidence: groupTask > 0 ? 100 : 0,
      reason: `填报流程会话自动聚合(${list.length} 会话,时间轴去重)`,
      sourceSessions: list.map((it) => ({ session: it.session, minutes: num(it.minutes) })),
      // 组归属可能取自非首条成员:taskName 等元数据不匹配时置空,防展示误导
      ...(groupTask > 0 && Number(list[0]!.task) !== groupTask ? { taskName: null, project: null, projectName: null } : {}),
      ...(groupTask > 0 ? {} : { candidates: list[0]!.candidates ?? [] }),
    });
  }
  const out: any[] = [];
  const emitted = new Set<string>();
  for (const it of items) {
    const key = groupOf.get(it);
    if (!key) {
      out.push(it); // 非 meta / already 保留原位
      continue;
    }
    if (emitted.has(key)) continue; // 组内第 2+ 成员:已由合并条取代
    emitted.add(key);
    out.push(mergedByKey.get(key)!); // 组内首个成员位置 → 合并条
  }
  return out;
}

export async function cmdPlan(client?: Client, cfg?: Record<string, any>, source: "cache" | "zentao" = "cache"): Promise<any> {
  const data = loadJSON<any>(SESSIONS_PATH, null);
  if (data === null) die(`会话数据不存在: ${SESSIONS_PATH}`);
  const date = data.date;
  const mappings = loadJSON<any>(MAPPINGS_PATH, { repoToProject: {}, branchToTask: {} });
  const submittedAll = loadJSON<any>(SUBMITTED_PATH, {});
  // 跨日期按 session id 查最近提交水位:长会话跨午夜时,提交记录在昨天的日期 key 下,
  // 仅按"今天 date"查会漏 → 当成全新会话(8h needs_semantic)。取所有日期里该 session 的
  // 最大 minutes 作水位,increment 才能正确算出跨午夜后的增量。
  const submittedBySession: Record<string, any> = {};
  for (const d of Object.keys(submittedAll)) {
    const day = submittedAll[d];
    if (!day || typeof day !== "object") continue;
    for (const sid of Object.keys(day)) {
      if (sid.startsWith("_")) continue; // _meta 跳过
      const r = day[sid];
      if (!r || typeof r !== "object") continue;
      const cur = submittedBySession[sid];
      if (!cur || (Number(r.minutes) || 0) > (Number(cur.minutes) || 0)) submittedBySession[sid] = r;
    }
  }
  // source=cache(默认)走 getCacheLocal 纯本地读,永不联网;source=zentao 走 getCache(refresh=true) 联网拉最新。
  // 不能用 getCache(client,cfg,false)——它有 TTL 过期检查,过期会联网,违背「本地缓存=不联网」的语义。
  const cache = source === "zentao" && client
    ? await getCache(client, cfg!, true)
    : getCacheLocal();
  if (!cache || !Array.isArray(cache.projects) || !Array.isArray(cache.tasks)) {
    die(`禅道任务缓存缺失或不完整: ${CACHE_PATH},请先运行 refresh 命令拉取`);
  }
  const projectNames: Record<number, string> = {};
  for (const p of cache.projects) projectNames[p.id] = p.name;
  const tasks = cache.tasks;
  const taskById: Record<number, any> = {};
  for (const t of tasks) taskById[t.id] = t;

  const taskInfo = async (taskId: number | null): Promise<any> => {
    let t = (taskId != null ? taskById[taskId] : undefined) || (cache.taskDetails || {})[String(taskId)];
    if (!t) {
      if (!client) return {}; // prepare 路径:cache 缺该任务时不联网,退化空(由 candidates 兜底)
      try {
        const raw = await client.get(`/tasks/${taskId}`);
        const ex = raw.execution;
        const pid = isObj(ex) ? (ex as any).project : raw.project;
        t = { name: raw.name ?? null, project: pid ?? null };
        cache.taskDetails[String(taskId)] = t;
        // 剥掉 getCache 返回值内嵌的 taskEfforts(增长大头,按任务拆在 efforts/,cache.json 不含)
        const { taskEfforts: _te, ...slim } = cache as any;
        writeJSON(CACHE_PATH, slim);
      } catch {
        return {};
      }
    }
    return {
      taskName: t.name ?? null,
      project: t.project ?? null,
      projectName: projectNames[t.project] ?? null,
    };
  };

  const items: any[] = [];
  // 开发时 note 写的 summary:有 summary 的 session 直接 resolved(跳过 AI 语义匹配/文案),省 /report 推理
  // 跨日期扫描所有 summary-*.json 按 session 聚合:长会话跨午夜时 note 散在多个日期文件,
  // 只读当天会漏(昨天的 note 读不到 → work=null)。扫 PROJECT_DIR 全部 summary 文件合并。
  const notesBySession = new Map<string, any[]>();
  // session=null 的 note(note 时新项目第一次未采集 session)→ 归当天最新 session(/report 时 Stop 已采集)。
  // 多天补报时 sessions 含历史日:end 是 "HH:MM" 无日期,直接全局取最晚会把昨天的当最新 →
  // 优先今天(date===采集日)里 end 最晚;今天没有才退全局最晚。
  const fallbackSid = (() => {
    const ss: any[] = Array.isArray(data.sessions) ? data.sessions : [];
    if (ss.length === 0) return "";
    const latest = (arr: any[]) => String([...arr].sort((x: any, y: any) => String(y.end ?? "").localeCompare(String(x.end ?? "")))[0]?.id ?? "");
    const todays = ss.filter((x: any) => !x.date || x.date === date);
    return latest(todays.length ? todays : ss);
  })();
  for (const fn of readdirSync(PROJECT_DIR)) {
    if (!/^summary-\d{4}-\d{2}-\d{2}\.json$/.test(fn)) continue;
    for (const sn of loadJSON<any[]>(path.join(PROJECT_DIR, fn), [])) {
      if (!sn) continue;
      const sid = sn.session || fallbackSid;
      if (!sid) continue;
      const arr = notesBySession.get(sid) ?? [];
      arr.push(sn);
      notesBySession.set(sid, arr);
    }
  }
  for (const s of data.sessions) {
    const item: any = {
      session: s.id,
      repo: s.repo,
      branch: s.branch,
      date: s.date || date, // 会话归属日(collect 按会话 lastActive 算):多天补报时 commit 按此提交禅道/记台账
      start: s.start,
      end: s.end,
      minutes: s.activeMinutes,
      summary: s.summary ?? "",
      meta: isMetaSkillSession(s), // 填报流程元会话(见 aggregateMetaItems):聚合用
      increment: false,
      work: null,
    };
    const rec = submittedBySession[s.id]; // 跨日期水位:长会话跨午夜时提交记录在昨天 key 下
    if (rec) {
      const tasksList = Array.isArray(rec.tasks) && rec.tasks.length ? rec.tasks : [null];
      const taskId = tasksList[tasksList.length - 1];
      const delta = s.activeMinutes - (rec.minutes ?? 0);
      if (delta < 15) {
        Object.assign(item, { status: "already", task: taskId, submittedHours: rec.hours ?? null }, await taskInfo(taskId));
      } else {
        // 增量补报:已提交会话已归属,增量沿用原 task(note 的 task=-1 表示"不确定",用会话已知归属)。
        // 水位严格大于:note 水位 == 提交水位 的 note 已随上次提交(单条路径 minutes=会话全量、
        // 拆段路径 minutes=segEnd),>= 会把已提交旧 note 的 work 混进增量重复报文案(08-15 实际踩坑)。
        const incNotes = notesBySession.get(s.id) || [];
        const submittedMin = rec.minutes ?? 0;
        const newIncNotes = waterNotes(incNotes).filter((n: any) => (Number(n.notedActiveMinutes) || 0) > submittedMin);
        // 增量 work = 水位后全部新 note 合并(旧→新、dedupLines 去重、≤MAX_INCREMENT_WORK_LINES):
        // 单取最新会丢增量区间内的关键改动(08-18 实测 4 条 note 只剩最后 1 条,前 3 个功能 commit 全丢)。
        // 早先「join 混排不搭」的顾虑已化解——auto note 自身就是窗口全量总结(见 buildAutoWork),
        // 多行是预期产物,render/numberWork 天然按行编号;无新 note 仍 null 走 AI 归纳。
        const incLines = dedupLines(newIncNotes.map((n: any) => String(n.work ?? "").trim()).filter(Boolean));
        const incCapped =
          incLines.length > MAX_INCREMENT_WORK_LINES
            ? [`…(更早 ${incLines.length - MAX_INCREMENT_WORK_LINES} 条略)`, ...incLines.slice(-MAX_INCREMENT_WORK_LINES)]
            : incLines;
        Object.assign(
          item,
          {
            status: "resolved",
            increment: true,
            task: taskId,
            hours: hoursFromMinutes(delta),
            confidence: 95,
            reason: "已提交会话的增量补报,沿用原任务",
            work: incCapped.length ? incCapped.join("\n") : null,
          },
          await taskInfo(taskId),
        );
      }
      items.push(item);
      continue;
    }
    // summary 覆盖:开发时已记 work + task。多 note(均有 notedActiveMinutes 水位)按时间段
    // 拆工时到各 task;任一 note 缺水位(老数据)→ 退化单 item(兼容历史行为)。
    const notes = notesBySession.get(s.id) || [];
    if (notes.length) {
      const wn = waterNotes(notes); // 有水位的新式 note,升序
      if (wn.length === notes.length) { // allHaveWater:所有 note 都有水位
        const total = Math.max(0, s.activeMinutes);
        if (total < 1) continue; // 0 工时会话不拆(避免 hoursFromMinutes(0)=0.5 凭空造条目)
        let prev = 0; // baseline:summary 分支无 prior submit
        const segItems: any[] = [];
        for (let i = 0; i < wn.length; i++) {
          const n = wn[i];
          if (!n) continue;
          const w = Math.max(0, Math.min(total, Number(n.notedActiveMinutes) || 0)); // clamp 到 [0,total]
          const isLast = i === wn.length - 1;
          const segEnd = isLast ? total : w; // 末条尾部归该 task(延续到现在)
          const segment = Math.max(0, segEnd - prev);
          prev = w; // 推进水位(即便本段=0 被跳过,下一条仍以 w 为起点)
          if (segment < 1) continue; // 跳过 0 段(同分钟多 note)
          // task<=0(-1):note 记录时未匹配任务 → unmatched,带候选任务供 /report 集中匹配,不进 resolved 提交
          const isUnmatched = !(Number(n.task) > 0);
          const info = isUnmatched
            ? null
            : n.taskName
              ? { taskName: n.taskName, project: n.project, projectName: n.projectName }
              : await taskInfo(n.task);
          segItems.push({
            ...item,
            status: isUnmatched ? "unmatched" : "resolved",
            task: n.task,
            work: n.work, // 单条 note 自己的 work(不 join)
            hours: hoursFromMinutes(segment),
            minutes: segEnd, // 该段末水位:recordSubmission 据此写防重水位(部分提交失败时不掩盖后续 task 工时)
            confidence: isUnmatched ? 0 : 100,
            reason: isUnmatched ? "note 记录 task=-1,待 /report 匹配任务" : "开发时 summary 记录(多 note 按水位拆分)",
            ...(isUnmatched ? { candidates: candidatesFor(s.repo, mappings, tasks, projectNames) } : info),
          });
        }
        // 膨胀检测:碎 note 每段 0.5h 下限累加会让拆段总 hours >> 整 session 工时
        // (如 18min 会话 3 条 note 拆 3 段=1.5h,实际 0.5h)。检测到则合并单 item,工时取整 session。
        const totalHours = hoursFromMinutes(total);
        const segSumHours = segItems.reduce((a: number, it: any) => a + (Number(it.hours) || 0), 0);
        if (segItems.length > 1 && segSumHours > totalHours + 0.01) {
          const allUnmatched = !segItems.some((it: any) => Number(it.task) > 0);
          const mainTask = segItems.find((it: any) => Number(it.task) > 0) || segItems[segItems.length - 1];
          const merged: any = {
            ...mainTask,
            hours: totalHours,
            minutes: total, // 防重水位 = 整 session activeMinutes(非 mainTask 的 note 水位,否则下次增量算多)
            work: segItems.map((it: any) => it.work).filter(Boolean).join("\n") || null,
            reason: "开发时 summary 记录(多 note 合并,避免拆段工时膨胀)",
            confidence: allUnmatched ? 0 : 100,
          };
          if (allUnmatched) {
            merged.status = "unmatched";
            merged.task = -1;
            merged.candidates = candidatesFor(s.repo, mappings, tasks, projectNames);
          } else {
            merged.status = "resolved";
          }
          items.push(merged);
        } else {
          items.push(...segItems);
        }
        continue;
      }
      // 退化:有 note 但缺水位(老数据) → 单 item(join 所有 work、n0.task、整 session hours)
      const n0 = notes[0];
      const isUnmatched0 = !(Number(n0.task) > 0);
      const info0 = isUnmatched0
        ? null
        : n0.taskName
          ? { taskName: n0.taskName, project: n0.project, projectName: n0.projectName }
          : await taskInfo(n0.task);
      Object.assign(
        item,
        {
          status: isUnmatched0 ? "unmatched" : "resolved",
          task: n0.task,
          work: notes.map((n: any) => n.work).join("\n"),
          hours: hoursFromMinutes(s.activeMinutes),
          confidence: isUnmatched0 ? 0 : 100,
          reason: isUnmatched0 ? "note 记录 task=-1,待 /report 匹配任务" : "开发时 summary 记录",
          ...(isUnmatched0 ? { candidates: candidatesFor(s.repo, mappings, tasks, projectNames) } : null),
        },
        info0,
      );
      items.push(item);
      continue;
    }
    item.hours = hoursFromMinutes(s.activeMinutes);
    const m = /task-(\d+)/.exec(s.branch || "");
    // 手动分支→任务映射(/mappings --branch --task 设,键 `${repo}:${branch}`):分支名无 task 号时
    // 用它直接归属,免落到 needs_semantic。优先级:summary note > 分支 task 号 > branchToTask > 语义匹配
    const btid = mappings.branchToTask ? mappings.branchToTask[`${s.repo}:${s.branch}`] : undefined;
    if (m) {
      const tid = parseInt(m[1], 10);
      Object.assign(item, { status: "resolved", task: tid, confidence: 95, reason: "分支名含任务号" }, await taskInfo(tid));
    } else if (btid) {
      Object.assign(item, { status: "resolved", task: btid, confidence: 95, reason: "branchToTask 手动映射" }, await taskInfo(btid));
    } else {
      const pid = mappings.repoToProject ? mappings.repoToProject[s.repo] : undefined;
      Object.assign(item, {
        status: "needs_semantic",
        reason: pid != null ? `仓库映射到项目 ${pid},候选已收窄` : "无仓库映射,候选为全部任务",
        candidates: candidatesFor(s.repo, mappings, tasks, projectNames),
      });
    }
    items.push(item);
  }

  // 元会话(填报流程会话)不需要 AI 归纳:needs_semantic 的直接按历史归属定 task——
  // 有历史(inferProjectTask>0)→ resolved;无(新项目首跑)→ unmatched 留 /report 问一次。再交聚合统一。
  for (const it of items) {
    if (!it.meta || it.status !== "needs_semantic") continue;
    const t = inferProjectTask(it.session);
    if (t > 0) {
      Object.assign(it, { status: "resolved", task: t, confidence: 90, reason: "填报流程元会话,按项目历史归属" }, await taskInfo(t));
    } else {
      Object.assign(it, { status: "unmatched", task: -1, confidence: 0, reason: "填报流程元会话,新项目无历史归属,待 /report 匹配" });
    }
  }

  // 元会话聚合:填报流程会话(report/prepare/amend skill 调用产生)同日同任务合并一条,
  // 时间区间并集去重工时——防填报工时自我繁殖 + 消禅道重复标题。AI 无需再手动合并同类条目。
  const aggregated = aggregateMetaItems(items);
  items.length = 0;
  items.push(...aggregated);

  // 顺手刷新本地项目名缓存,供 mappings 离线查看
  mappings.projectNames = {};
  for (const [k, v] of Object.entries(projectNames)) mappings.projectNames[String(k)] = v;
  writeJSON(MAPPINGS_PATH, mappings);

  // 算 left(剩余工时):从 cache task.left 按 task 累减 hours,填 item.left。
  // commit 时 submitEffort 收到非 null left 即跳过 GET /tasks/{id}(省每条一次网络往返)。
  // fallback:cache 无该 task 或 left 缺失 → item.left 留 undefined → submitEffort 仍 GET(保底,不丢准确性)。
  const leftByTask: Record<number, number> = {}; // taskId → 当前剩余(同 task 多条累减)
  for (const it of items) {
    if (it.status !== "resolved" || it.task == null || it.hours == null) continue;
    if (leftByTask[it.task] === undefined) {
      const t = taskById[it.task];
      const l = t ? Number(t.left) : NaN;
      if (!Number.isFinite(l)) continue; // cache 无该 task / left 缺失 → 该 task 走 fallback GET
      leftByTask[it.task] = l;
    }
    leftByTask[it.task] = Math.max(roundPy(leftByTask[it.task] - it.hours, 1), 0);
    it.left = leftByTask[it.task];
  }

  // draftSeq 跨 plan 保留(同日多次 plan/render 不重置,草稿编号持续递增);日期变了才归零。
  // render 内部自动重 plan 也走这里——若每次重置,调整→重 render 会一直显示 #001,编号失去「第几版」意义。
  const prevPlan = loadJSON<any>(PLAN_PATH, null);
  const draftSeq = prevPlan?.date === date && Number.isFinite(Number(prevPlan.draftSeq)) ? Number(prevPlan.draftSeq) : 0;
  const plan = { date, draftSeq, items };
  writeJSON(PLAN_PATH, plan);
  // cooldown 预判:返回给调用方(SKILL 据此决定是否 render/commit,避免 commit 失败再查)。
  // 全局取最近 lastCommitAt(跨所有日期 key):补报场景最后提交可能落在历史日 key 下。
  const lastAt = latestCommitAt(submittedAll);
  let cooldown: { waitMinutes: number; lastCommitAt: string } | null = null;
  if (lastAt) {
    const elapsed = minutesSinceISO(lastAt);
    if (elapsed < COMMIT_COOLDOWN_MINUTES) {
      cooldown = { waitMinutes: Math.trunc(COMMIT_COOLDOWN_MINUTES - elapsed) + 1, lastCommitAt: lastAt };
    }
  }
  return { ...plan, cooldown };
}

function cmdRender(): string {
  const plan = loadJSON<any>(PLAN_PATH, null);
  if (plan === null) die(`计划不存在,请先运行 plan 命令: ${PLAN_PATH}`);
  const items = plan.items;
  const pending = [...new Set(items.filter((i: any) => i.status === "needs_semantic" || i.status === "unmatched").map((i: any) => i.session))];
  if (pending.length) die("尚有会话未完成归属(needs_semantic/unmatched),补全后才能渲染草稿", { sessions: pending });
  const noWork = items.filter((i: any) => i.status === "resolved" && !i.work).map((i: any) => i.session);
  if (noWork.length) die("以下 resolved 条目缺少 work 字段(工作内容)", { sessions: noWork });
  plan.draftSeq = (plan.draftSeq ?? 0) + 1;
  writeJSON(PLAN_PATH, plan);

  const lines: string[] = [
    `工时草稿 #ZR-${plan.date.replace(/-/g, "")}-${String(plan.draftSeq).padStart(3, "0")}`,
    "",
  ];
  // 多天补报条目(归属日≠采集日)时间前加 [补 MM-DD],今天的照常——核对时一眼分辨补的是哪天。
  const dateTag = (i: any): string => (i.date && i.date !== plan.date ? `[补 ${i.date.slice(5)}] ` : "");
  let n = 0;
  for (const i of items) {
    if (i.status !== "resolved") continue;
    n++;
    const inc = i.increment ? "(增量)" : "";
    const merged = Array.isArray(i.sourceSessions) && i.sourceSessions.length > 1 ? `(${i.sourceSessions.length} 会话合并)` : "";
    // 内容逐条一行(确认展示对齐日报/周报):work 内以 ;/；分隔的多条记录拆行编号;
    // 仅改草稿显示,plan.json 的 work 原样不动(提交禅道的文案不受影响)。
    const parts = String(i.work).split(/[;；\n]/).map((s) => s.trim().replace(LEADING_INDEX_RE, "")).filter(Boolean);
    const workLines = parts.length > 1
      ? [`    内容:`, ...parts.map((s, k) => `    ${k + 1}. ${s}`)]
      : [`    内容:${i.work}`];
    lines.push(
      `[${n}] ${i.projectName || i.repo}(项目#${i.project}) / ${i.taskName || "?"}(任务#${i.task})`,
      `    ${dateTag(i)}${i.start}—${i.end},${fmtHours(i.hours)}小时${inc}${merged}`,
      ...workLines,
      `    置信度:${i.confidence}%`,
      `    理由:${i.reason ?? null}`,
      "",
    );
  }
  const skipped = items.filter((i: any) => i.status === "skipped");
  if (skipped.length) {
    lines.push("跳过(不提交):");
    for (const i of skipped) {
      lines.push(
        `[·] ${i.repo}/${i.branch} ${dateTag(i)}${i.start}—${i.end},${fmtHours(i.hours || hoursFromMinutes(i.minutes))}小时 — ${i.skipReason || "用户选择跳过"}`,
      );
    }
    lines.push("");
  }
  const already = items.filter((i: any) => i.status === "already");
  if (already.length) {
    // 已提交条目折叠为一行:提交后 sessions 仍在窗口内,逐条展开会刷屏——元会话聚合的防重
    // 是逐源会话记录的,提交后摊回 N 行「0.0小时」纯噪音(08-18 用户实测吐槽);分钟水位防重不受影响。
    lines.push(`已提交(本次不再提交):${already.length} 条会话,防重跳过`);
    lines.push("");
  }
  lines.push("状态:未提交");
  return lines.join("\n");
}

function recordSubmission(date: string, session: string, taskId: number, hours: number, minutes: number | null): any {
  const log = existsSync(SUBMITTED_PATH) ? JSON.parse(readFileSync(SUBMITTED_PATH, "utf8")) : {};
  if (!log[date]) log[date] = {};
  const day = log[date];
  if (!day[session]) day[session] = { tasks: [], hours: 0, minutes: 0 };
  const rec = day[session];
  if (!rec.tasks.includes(taskId)) rec.tasks.push(taskId);
  rec.hours = roundPy(rec.hours + hours, 1);
  if (minutes !== null && minutes !== undefined) rec.minutes = minutes;
  writeJSON(SUBMITTED_PATH, log);
  return rec;
}

/** 提交流水逐笔落盘(ZENPILOT_HOME/submitted/<date>.jsonl,append-only 永不覆盖)。
 *  禅道 API 返回 submitted 后调用,与 recordSubmission(冷却用聚合)互补;
 *  daemon collectWorklogs 读此目录全量上报 tokenserver,逐笔镜像禅道工时记录
 *  (plan.json 同会话同任务只存一条会被顶替,流水按行累积,行号即 subId=date:行号)。
 *  并发:不同项目同时 commit 会写同一日文件,单行 <1KB 的 append 原子性足够;
 *  极端交错的坏行 daemon 解析时跳过,不会污染其余行。 */
function appendSubmittedLog(e: {
  date: string;
  session: string;
  cwd: string;
  repo: string | null;
  branch: string | null;
  start: string | null;
  end: string | null;
  minutes: number | null;
  hours: number;
  task: number;
  taskName: string | null;
  project: number | null;
  projectName: string | null;
  work: string;
}): void {
  mkdirSync(SUBMITTED_LOG_DIR, { recursive: true });
  try {
    appendFileSync(path.join(SUBMITTED_LOG_DIR, `${e.date}.jsonl`), JSON.stringify({ ts: nowISOSeconds(), ...e }) + "\n", "utf8");
  } catch (err) {
    // 落盘失败不中断提交循环(后续条目仍要报禅道),但流水缺行=镜像缺笔,必须大声报出来
    console.error(`[appendSubmittedLog] 流水落盘失败(该笔已提交禅道,但不会出现在 tokenserver): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 提交禅道的工作内容加序号+逐条 AI 标识:按 ;/；/\n 拆条 → 去行首旧序号 → 重新 1..N,
 *  每条行尾拼 AI 标识(幂等,已有不重拼)→ \n 换行拼接。
 *  去旧序号正则限定 1-3 位数字且后面不是数字((?!\d))——防误剥「3.0 升级依赖」「2024.1 修复」这类版本号开头的文案。
 *  禅道侧逐条多行展示(对齐手填记录格式);报表/日报读原文(\n 渲染转 <br>),AI 排版时再统一顺延编号。 */
const LEADING_INDEX_RE = /^\d{1,3}[.、](?!\d)\s*/;
function numberWork(work: string, mark: { enabled: boolean; text: string }): string {
  const tail = mark.enabled && mark.text ? `(${mark.text})` : "";
  const parts = String(work).split(/[;；\n]/).map((s) => s.trim().replace(LEADING_INDEX_RE, "")).filter(Boolean);
  return parts.map((s, k) => `${k + 1}. ${!tail || s.endsWith(tail) ? s : s + tail}`).join("\n");
}

/** 全局最近一次 commit 时间:扫 submitted.json 所有日期 key 的 _meta.lastCommitAt 取最大。
 *  多天补报后最后提交可能落在历史日 key 下,只看当天会漏(也顺手修「昨天 23:59 提交、今天 00:05 不冷却」)。 */
function latestCommitAt(log: Record<string, any>): string | null {
  let max: string | null = null;
  for (const d of Object.keys(log)) {
    const at = log[d]?._meta?.lastCommitAt;
    if (typeof at === "string" && (max === null || at > max)) max = at;
  }
  return max;
}

/** 提交冷却检查:距上次 commit < COMMIT_COOLDOWN_MINUTES 返回 {waitMinutes, lastCommitAt, elapsed},否则 null。cmdCommit(die)+cmdAuto(return)共用,消除冷却逻辑复制。 */
function checkCooldown(): { waitMinutes: number; lastCommitAt: string; elapsed: number } | null {
  const lastAt = latestCommitAt(loadJSON<any>(SUBMITTED_PATH, {}));
  if (!lastAt) return null;
  const elapsed = minutesSinceISO(lastAt);
  if (elapsed >= COMMIT_COOLDOWN_MINUTES) return null;
  return { waitMinutes: Math.trunc(COMMIT_COOLDOWN_MINUTES - elapsed) + 1, lastCommitAt: lastAt, elapsed };
}

export async function cmdCommit(client: Client, opts: { dryRun?: boolean; amend?: boolean }): Promise<any> {
  const dryRun = !!opts.dryRun;
  const amend = !!opts.amend;
  const plan = loadJSON<any>(PLAN_PATH, null);
  if (plan === null) die(`计划不存在,请先运行 plan 命令: ${PLAN_PATH}`);
  const items = plan.items;
  const pending = [...new Set(items.filter((i: any) => i.status === "needs_semantic" || i.status === "unmatched").map((i: any) => i.session))];
  if (pending.length) die("尚有会话未完成归属(needs_semantic/unmatched),不能提交", { sessions: pending });
  const toSubmit = items.filter((i: any) => i.status === "resolved");
  const noWork = toSubmit.filter((i: any) => !i.work).map((i: any) => i.session);
  if (noWork.length) die("以下条目缺少 work 字段,不能提交", { sessions: noWork });
  const submittedAll = loadJSON<any>(SUBMITTED_PATH, {});
  if (amend) {
    // 定位「最后一次提交」:全局扫所有日期 key 取最大 lastCommitAt,合并同值天数的 lastCommit
    // (同一次 commit 各日期 key 盖同一时间戳)。多天补报后最后提交常落在历史日 key,只看 plan.date 找不到。
    const lastAt = latestCommitAt(submittedAll);
    const lastCommit = lastAt
      ? Object.keys(submittedAll).flatMap((d) => {
          const m = submittedAll[d]?._meta;
          return m?.lastCommitAt === lastAt && Array.isArray(m.lastCommit) ? m.lastCommit : [];
        })
      : [];
    if (!lastCommit.length) die("没有可修正的提交:还没有 commit 记录");
    const allowed = new Set(lastCommit.map((e: any) => e.session));
    const extra = toSubmit.filter((i: any) => !allowed.has(i.session)).map((i: any) => i.session);
    if (extra.length) {
      die("amend 只能修正最后一次提交包含的会话,其余条目请改回 skipped 或等冷却后走 commit", {
        sessions: extra,
        lastCommitSessions: [...allowed].sort(),
      });
    }
  } else if (toSubmit.length && !dryRun) {
    const cd = checkCooldown();
    if (cd) {
      die(
        `距上次提交仅 ${Math.trunc(cd.elapsed)} 分钟,两次提交间隔须≥${COMMIT_COOLDOWN_MINUTES}分钟。用户明确要求修正最后一次提交时,用 amend 命令(禅道只能追加更正记录)`,
        { lastCommitAt: cd.lastCommitAt, waitMinutes: cd.waitMinutes },
      );
    }
  }
  const mappings = loadJSON<any>(MAPPINGS_PATH, { repoToProject: {}, branchToTask: {} });
  const mark = loadMarkSetting(); // AI 提交标识(开关+文案),循环外读一次
  const results: any[] = [];
  for (const i of toSubmit) {
    const itemDate = i.date || plan.date; // 条目归属日:补报条目按会话实际日期提交禅道/记台账,今天的不变
    let out: any;
    try {
      out = await client.submitEffort(i.task, itemDate, i.hours, numberWork(i.work, mark), i.left ?? null, dryRun);
    } catch (e) {
      out = { submitted: false, error: e instanceof Error ? e.message : String(e) }; // 单条失败不崩,继续其他条目
    }
    if (out.submitted) {
      // 合并条(元会话聚合):对每个源会话记防重水位(hours=0=工时在合并条、minutes=各源 activeMinutes)
      // → 下次 plan 各源 delta=0 → already,填报流程会话不再繁殖。
      if (Array.isArray(i.sourceSessions) && i.sourceSessions.length) {
        for (const src of i.sourceSessions) {
          recordSubmission(itemDate, src.session, i.task, 0, src.minutes ?? null);
        }
      } else {
        recordSubmission(itemDate, i.session, i.task, i.hours, i.minutes);
      }
      appendSubmittedLog({
        date: itemDate,
        session: i.session,
        cwd: PROJECT_CWD,
        repo: typeof i.repo === "string" ? i.repo : null,
        branch: typeof i.branch === "string" ? i.branch : null,
        start: typeof i.start === "string" ? i.start : null,
        end: typeof i.end === "string" ? i.end : null,
        minutes: typeof i.minutes === "number" ? i.minutes : null,
        hours: i.hours,
        task: i.task,
        taskName: typeof i.taskName === "string" ? i.taskName : null,
        project: typeof i.project === "number" ? i.project : null,
        projectName: typeof i.projectName === "string" ? i.projectName : null,
        work: numberWork(i.work, mark), // 落实际提交文案(序号+逐条 AI 标识),与禅道记录逐字一致
      });
      if (i.project) {
        mappings.repoToProject[i.repo] = i.project;
        if (i.projectName) {
          if (!mappings.projectNames) mappings.projectNames = {};
          mappings.projectNames[String(i.project)] = i.projectName;
        }
      }
    }
    results.push({ session: i.session, hours: i.hours, date: itemDate, ...out });
  }
  const ok = results.filter((r: any) => r.submitted);
  if (!dryRun) {
    writeJSON(MAPPINGS_PATH, mappings);
    if (ok.length) {
      // 回写 cache:更新已提交 task 的 left/consumed,保证下次 plan 读到准 left(单机闭环)。
      // r.left = submitEffort 返回的禅道剩余(非 null 才覆盖);consumed 累加本次 hours。
      const cache0 = loadJSON<any>(CACHE_PATH, null);
      if (cache0 && Array.isArray(cache0.tasks)) {
        const byId = new Map<number, any>();
        for (const t of cache0.tasks) if (t && t.id != null) byId.set(t.id, t);
        let changed = false;
        for (const r of ok) {
          const t = r.task?.id != null ? byId.get(r.task.id) : undefined;
          if (!t) continue;
          if (r.left != null) { t.left = r.left; changed = true; }
          if (r.hours) { t.consumed = roundPy(Number(t.consumed ?? 0) + r.hours, 1); changed = true; }
        }
        if (changed) writeJSON(CACHE_PATH, cache0);
      }
      const log = loadJSON<any>(SUBMITTED_PATH, {}); // 重新读盘:循环内 recordSubmission 已写过,不能复用开头副本(会顶掉)
      // 按条目归属日分组写 _meta:同一次 commit 的各日期 key 盖同一 lastCommitAt(amend 据此合并定位「最后一次提交」)。
      const now = nowISOSeconds();
      const byDate = new Map<string, any[]>();
      for (const r of ok) {
        const d = r.date || plan.date;
        if (!byDate.has(d)) byDate.set(d, []);
        byDate.get(d)!.push({ session: r.session, task: r.task.id, hours: r.hours });
      }
      for (const [d, entries] of byDate) {
        if (!log[d]) log[d] = {};
        const day = log[d];
        if (amend && day._meta) {
          day._meta.amendedAt = now;
          day._meta.lastCommit = day._meta.lastCommit.concat(entries);
        } else {
          day._meta = { lastCommitAt: now, lastCommit: entries };
        }
      }
      writeJSON(SUBMITTED_PATH, log);
      // 注:不做「提交后自动刷缓存」——改为报表侧按需刷新(report.ts cacheStaleVsSubmissions:
      // daily/weekly 发现缓存旧于最后一笔提交时同步先刷新再读),commit 保持纯净,零跨进程坑。
    }
  }
  return {
    date: plan.date,
    dryRun,
    amend,
    submitted: ok.length,
    skipped: items.filter((i: any) => i.status === "skipped").map((i: any) => i.session),
    results,
    mappings,
  };
}

/** 一键填报:collect → plan → (全 resolved 时)直接 commit。默认自动提交不确认;
 *  有 needs_semantic / resolved 缺 work / 提交冷却 时停下,返回相应 action 让调用方(AI)处理。
 *  die()=process.exit,故 cmdCommit 的前置检查(pending/noWork/cooldown)在此自做、return 而非 die。 */
async function cmdAuto(client: Client, cfg: Record<string, any>, a: Args): Promise<any> {
  const dryRun = !!a["dry-run"];
  const collected = await cmdCollect();
  if (collected.error) return { action: "abort", step: "collect", error: collected.error };
  const plan = await cmdPlan(client, cfg);
  const items = plan.items;
  const pending = [...new Set(items.filter((i: any) => i.status === "needs_semantic" || i.status === "unmatched").map((i: any) => i.session))];
  const unmatched = items
    .filter((i: any) => i.status === "unmatched")
    .map((i: any) => ({ session: i.session, work: i.work, hours: i.hours, repo: i.repo, branch: i.branch, candidates: i.candidates ?? [] }));
  if (pending.length) return { action: "needs_review", reason: "有待匹配(needs_semantic/unmatched)需 AI 处理", pending, unmatched, plan };
  const toSubmit = items.filter((i: any) => i.status === "resolved");
  const noWork = toSubmit.filter((i: any) => !i.work).map((i: any) => i.session);
  if (noWork.length) return { action: "needs_review", reason: "有 resolved 缺 work", noWork, plan };
  // 提交冷却:复制 cmdCommit 的检查,return 而非 die
  if (toSubmit.length && !dryRun) {
    const cd = checkCooldown();
    if (cd) return { action: "cooldown", lastCommitAt: cd.lastCommitAt, waitMinutes: cd.waitMinutes };
  }
  const draft = cmdRender();
  if (toSubmit.length === 0) return { action: "nothing", draft, plan };
  const result = await cmdCommit(client, { dryRun });
  return { action: "committed", draft, result };
}

/** task<=0 时,沿用项目已关联任务:优先该 session 历史提交的 task,次选该项目任意会话最近的 task。
 *  防 AI 记 note 偷懒传 -1 导致已关联项目丢失归属。无关联返回 -1。 */
function inferProjectTask(session: string | null | undefined): number {
  try {
    const all = loadJSON<any>(SUBMITTED_PATH, {});
    const dates = Object.keys(all).sort().reverse();
    for (const d of dates) {
      const rec = all[d]?.[session];
      if (rec?.tasks?.length) return Number(rec.tasks[rec.tasks.length - 1]) || -1;
    }
    for (const d of dates) {
      const day = all[d];
      if (!isObj(day)) continue;
      for (const sid of Object.keys(day)) {
        if (sid.startsWith("_")) continue;
        const rec = (day as any)[sid];
        if (rec?.tasks?.length) return Number(rec.tasks[rec.tasks.length - 1]) || -1;
      }
    }
  } catch {
    /* 无 submitted 或读失败 → -1 */
  }
  return -1;
}

/** note 落盘共用:taskName/project/projectName 从 cache 补全 + notedActiveMinutes 水位快照 +
 *  写 summary-<sessions.json.date>.json。cmdNote(手动/AI)与 autoNote(Stop 自动)共用。
 *  extra 追加字段(auto:true / sigLastMs,auto-note 用)。返回文件路径。 */
function appendNote(session: string | null, work: string, task: number, extra?: Record<string, unknown>): string {
  let taskName: string | null = null;
  let project: number | null = null;
  let projectName: string | null = null;
  const cache = loadJSON<any>(CACHE_PATH, null);
  const t = cache?.tasks?.find((x: any) => x.id === task);
  if (t) {
    taskName = t.name ?? null;
    project = t.project ?? null;
    projectName = cache?.projects?.find((p: any) => p.id === project)?.name ?? null;
  }
  // 多 note 水位:拍快照当前 session 的 activeMinutes,供 cmdPlan 按时间段拆工时到各 task。
  // 老 note 无此字段 → cmdPlan 端判否退化单 item。sessions.json 由 Stop hook 每轮刷新,此处读上一轮值够用。
  let notedActiveMinutes: number | null = null;
  let summaryDate = todayISO();
  try {
    const sd = loadJSON<{ sessions: any[]; date?: string }>(SESSIONS_PATH, { sessions: [] });
    // summary 按 sessions.json.date 命名:跨午夜报当天会话时 date 是当天,sessions.json 仍持有该会话,
    // note 落到当天的 summary(与 plan 读取同路径)。不强制 sd.date===今天,否则跨午夜拍不到水位退化 null。
    if (typeof sd.date === "string") summaryDate = sd.date;
    const found = (Array.isArray(sd.sessions) ? sd.sessions : []).find((x: any) => x.id === session);
    if (found && typeof found.activeMinutes === "number") notedActiveMinutes = found.activeMinutes;
  } catch {
    /* null:cmdPlan 退化老行为 */
  }
  const smp = summaryPathFor(summaryDate);
  const list = loadJSON<any[]>(smp, []);
  list.push({ session, ts: nowISOSeconds(), work, task, taskName, project, projectName, notedActiveMinutes, ...extra });
  writeJSON(smp, list);
  return smp;
}

/** 开发时记一条功能总结到 summary-YYYY-MM-DD.json(按项目+日期)。
 *  work=功能点编号文案, task=禅道任务ID, session 未传则取当天最新活跃会话。
 *  自动从 cache.json 补 taskName/project/projectName。/report plan 直读省 AI 填空。 */
function cmdNote(a: Args): any {
  const work = requireStr(a, "work");
  let session: string | null | undefined = a.session !== undefined ? String(a.session) : undefined;
  if (!session) {
    const data = loadJSON<{ sessions: any[]; date?: string }>(SESSIONS_PATH, { sessions: [] });
    const sessions = Array.isArray(data.sessions) ? data.sessions : [];
    if (sessions.length > 0) {
      // 取 end 最晚的(最新活跃);end 是 "HH:MM" 字符串,字符串排序即时间序。
      // 多天补报时 sessions 含历史日(end 无日期,全局取最晚会把昨天 22:00 当最新)→
      // 与 cmdPlan fallbackSid 同口径:优先今天(date===采集日)里 end 最晚,今天没有才退全局。
      const byEnd = (arr: any[]) => [...arr].sort((x, y) => String(y.end ?? "").localeCompare(String(x.end ?? "")));
      const todays = sessions.filter((x: any) => !x.date || x.date === data.date);
      session = byEnd(todays.length ? todays : sessions)[0]?.id;
    }
    // 新项目第一次:sessions.json 未采集(Stop 在响应结束才采集)+ 无 CLAUDE_SESSION_ID env
    // → 记 session=null,/report 时 plan 把 session=null 的 note 归到当天最新 session(那时 Stop 已采集)
    if (!session) session = process.env.CLAUDE_SESSION_ID || null;
  }
  // task:显式传 > 项目历史关联任务(防 AI 偷懒传 -1 丢失已关联项目归属)> -1
  const taskRaw = a.task !== undefined ? parseInt(String(a.task), 10) : -1;
  let task = Number.isNaN(taskRaw) ? -1 : taskRaw;
  if (task <= 0) task = inferProjectTask(session);
  const smp = appendNote(session, work, task);
  const entries = loadJSON<any[]>(smp, []).length;
  return { ok: true, file: smp, session, entries, work };
}

// ---------- auto-note:Stop 时自动归纳 work+task 写 summary(零 LLM,无感) ----------
// 素料 = daemon 预提取的 signals.turns[].conclusion(Claude 本轮结论文本,已是自然语言汇报),
// 取「水位之后最新非空 conclusion」精简成一句话当 work;task 走 inferProjectTask 历史回退。
// 由 collect 命令尾部(Stop hook detached fork)触发,全程静默失败不出声。

/** 同会话两次 auto-note 最短间隔:防快速连续 Stop 刷碎条(拆段语义不受影响,下次 note 段=上条水位起)。 */
export const AUTO_NOTE_MIN_INTERVAL_MS = 10 * 60_000;

/** 单条 auto note 的 work 行数上限:10min 节流窗内罕见超;超出保留最新 N 行,旧的用「…(前 N 轮略)」标记。 */
export const MAX_AUTO_NOTE_LINES = 4;

/** 增量补报条目的 work 行数上限:14 天大窗防爆;超出保留最新 N 行,旧的用「…(更早 N 条略)」标记。 */
export const MAX_INCREMENT_WORK_LINES = 10;

/** 归一化去重:完全相同或互为包含的行只留长者(短行是长行子集,信息已被覆盖),保持原有先后顺序。
 *  归一化去空白和标点——「开发。」与「开发并通过测试。」才构成前缀包含,带标点会漏判。 */
export function dedupLines(lines: string[]): string[] {
  const norm = (s: string) => s.replace(/[\s。;,.、!??::;()()\[\]【】《》\-—~"'']/g, "").toLowerCase();
  const out: string[] = [];
  for (const l of lines) {
    const nl = norm(l);
    if (!nl) continue;
    const hit = out.find((o) => {
      const no = norm(o);
      return no === nl || no.includes(nl) || nl.includes(no);
    });
    if (hit !== undefined) {
      if (nl.length > norm(hit).length) out[out.indexOf(hit)] = l; // 留长者
    } else out.push(l);
  }
  return out;
}

/** conclusion 原文 → 一句话 work:逐行找首个非标题/非列表/非引导语行 → 去行内 markdown → 取首句(≤120 字)。
 *  引导语(「文案已改好,草稿如下:」「草稿已渲染,请核对:」这类以冒号/「如下」收尾的展示引导)跳过找下一行
 *  ——它们是回复的开场白不是工作结论,当 work 会明显异常、诱发 AI 提交时再修(2026-08-18 实测踩坑)。
 *  <10 字(如「好的」)返回 null——无信息量不记。 */
const LEADIN_RE = /[:：]\s*$|(如下|请核对|请确认|请查收|请查阅)[。!?]?\s*$/;
// 流程状态语开头(/report 交互轮的 conclusion 常见):描述流程本身而非工作成果
const STATUS_RE = /^(已取消|已提交|已渲染|草稿已|工时草稿|好的[,，])/;
// API 错误残行(turn 中途断线时 transcript 的 conclusion 就是错误文案,不是工作成果)
const ERROR_RE = /^(api error|error:|connection (lost|reset|refused)|network error|timeout)/i;
// 草稿标签行(render 草稿的元数据行,被整段回显时会成为 conclusion 候选)
const LABEL_RE = /^(理由|置信度|内容|状态|汇总)[:：]/;
export function simplifyConclusion(text: string): string | null {
  const lines = text.split("\n").map((l) => l.trim());
  // 行级跳过:空/太短(<10 字提不出合格首句,代码围栏短行同理)/标题列表/代码围栏/引导语/markdown 表格行/流程状态语/草稿引用行/时钟时间行(「09:45—12:11,2.0小时」)/API 错误残行/草稿标签行
  const skip = (l: string) =>
    !l || l.length < 10 || /^(#{1,6}\s|>|[-*+]\s|\d+[.、]\s|\[\d+\]\s?|\d{1,2}:\d{2}|```|\|)/.test(l) || LEADIN_RE.test(l) || STATUS_RE.test(l) || ERROR_RE.test(l) || LABEL_RE.test(l);
  const body = lines.find((l) => !skip(l)) ?? "";
  let s = body.replace(/[*`#>]/g, "").replace(/\s+/g, " ").trim();
  const m = /^(.{2,120}?[。;;.!?])/.exec(s);
  s = m ? m[1]! : s.length > 100 ? s.slice(0, 100) + "…" : s;
  return s.length >= 10 && !LEADIN_RE.test(s) ? s : null;
}

/** 新 turns(水位后)→ {work, lastMs}。窗口全量:每个 turn 的 conclusion 各精简一行(空/无信息量
 *  conclusion 的 turn 有 commits 则用 commit subject 行),按时间旧→新 join——单取最新会丢节流窗内
 *  中间 turn 的结论(08-18 实测 4 条 note 只剩最后 1 条)。去重后 ≤MAX_AUTO_NOTE_LINES 行;
 *  全无素材 → null(调用方不推进水位,下次 Stop 自愈——如 daemon 消费 tick 还没跑完最新 turn)。 */
export function buildAutoWork(turns: any[], sinceMs: number): { work: string; lastMs: number } | null {
  const fresh = (Array.isArray(turns) ? turns : []).filter((t) => t && num(t.endMs) > sinceMs);
  if (fresh.length === 0) return null;
  const lastMs = Math.max(...fresh.map((t) => num(t.endMs)));
  const lines: string[] = [];
  for (const t of fresh) {
    const c = typeof t.conclusion === "string" ? t.conclusion.trim() : "";
    const work = simplifyConclusion(c);
    if (work) {
      lines.push(work);
      continue;
    }
    // commit subject 回退:剥 conventional-commit 类型前缀(feat(report): 等),留人类可读正文
    const subjects = (Array.isArray(t.commits) ? t.commits.map(String) : [])
      .map((s) => s.replace(/^(?:feat|fix|docs|chore|perf|refactor|test|style|build|ci|revert)(?:\([\w.\-/]+\))?:\s*/i, "").trim())
      .filter(Boolean);
    if (subjects.length) lines.push(subjects.join(";"));
  }
  const merged = dedupLines(lines);
  if (merged.length === 0) return null;
  const capped =
    merged.length > MAX_AUTO_NOTE_LINES
      ? [`…(前 ${merged.length - MAX_AUTO_NOTE_LINES} 轮略)`, ...merged.slice(-MAX_AUTO_NOTE_LINES)]
      : merged;
  return { work: capped.join("\n"), lastMs };
}

/** 该 session 的 auto-note 水位:扫全部 summary-*.json 取 max(sigLastMs, 手动 note.ts 的 epoch)。
 *  手动 note(无精确 turn 水位)按「记的时刻覆盖之前所有工作」计入 ts——AI 刚记过(质量更高)auto 不再重复记;
 *  auto note 只用自己的 sigLastMs(turn 精确结束时刻),ts 不计入——否则水位被推到写入时刻,
 *  会跳过 endMs 落在「turn 结束~写入」之间的 turn(daemon 消费 tick 滞后场景漏记)。
 *  lastNoteAt = 最后一条 note(任意来源)的 ts,供节流判断。 */
export function noteWatermark(sessionId: string): { sinceMs: number; lastNoteAt: number } {
  let sinceMs = 0;
  let lastNoteAt = 0;
  try {
    for (const fn of readdirSync(PROJECT_DIR)) {
      if (!/^summary-\d{4}-\d{2}-\d{2}\.json$/.test(fn)) continue;
      for (const n of loadJSON<any[]>(path.join(PROJECT_DIR, fn), [])) {
        if (!n || n.session !== sessionId) continue;
        sinceMs = Math.max(sinceMs, num(n.sigLastMs));
        const t = new Date(String(n.ts)).getTime();
        if (Number.isFinite(t)) lastNoteAt = Math.max(lastNoteAt, t);
        if (n.auto !== true && Number.isFinite(t)) sinceMs = Math.max(sinceMs, t); // 仅手动 note 的 ts 计入
      }
    }
  } catch {
    /* 读不到按 0 */
  }
  return { sinceMs, lastNoteAt };
}

/** Stop hook 触发的自动归纳:精查该会话 signals → 水位后新 turns 取 conclusion 精简 → 写 note。
 *  开关 settings.autoNote(默认开,false 关);task=inferProjectTask 回退(-1 留 /report 问)。
 *  sigIn:测试注入信号(生产 undefined 走 daemon 精查)。
 *  任何失败静默返回——后台自动动作,绝不出声、绝不阻塞(collect 已 detached)。 */
export async function autoNote(sessionId: string | null, sigIn?: any | null): Promise<void> {
  try {
    if (!sessionId) return;
    if (loadJSON<any>(SETTINGS_PATH, {}).autoNote === false) return;
    const sig = sigIn !== undefined ? sigIn : await fetchDaemonSignals(PROJECT_CWD, sessionId);
    if (!sig || !Array.isArray(sig.turns) || sig.turns.length === 0) return;
    const wm = noteWatermark(sessionId);
    if (wm.lastNoteAt && Date.now() - wm.lastNoteAt < AUTO_NOTE_MIN_INTERVAL_MS) return; // 节流
    const built = buildAutoWork(sig.turns, wm.sinceMs);
    if (!built) return; // 无可用素材:不推进水位,下次 Stop 自愈
    appendNote(sessionId, built.work, inferProjectTask(sessionId), { auto: true, sigLastMs: built.lastMs });
  } catch {
    /* 静默 */
  }
}

/** 提前准备:collect→plan(本地)→挑 pending→附 transcript 信号。把 /report 最慢的 AI 填空前置到这里。
 *  全程不登录禅道、不调 client、不读写 submitted.json、不碰 cooldown——只读 + 给 AI 输出原料。
 *  AI 据此生成 work+选 task 调 note 写 summary;/report auto 即可全 resolved 秒级 commit。
 *  uncertain(多任务判不准)的留 /report 用 AskUserQuestion 问,复用这里留的 candidates。 */
async function cmdPrepare(): Promise<any> {
  const collected = await cmdCollect();
  if (collected.error) return { action: "abort", step: "collect", error: collected.error };

  const cache = getCacheLocal();
  if (cache === null) {
    return { action: "needs_cache", hint: "禅道任务缓存为空,先运行 refresh 命令(或 /shine-worklog:report 内部 refresh)拉取我的任务" };
  }

  const plan = await cmdPlan(undefined, undefined); // 走纯本地缓存,不联网
  const items: any[] = plan.items || [];
  // 关键信号一次拉全(daemon 后台预提取,秒回;since=自上次提交日,与 collect 范围一致,补报会话也有信号);
  // null=daemon 不可达/旧版无端点 → pending 逐条退化直读 transcript
  const sigMap = await fetchDaemonSignalsMap(PROJECT_CWD, lastSubmitSinceEpoch());
  const ready: any[] = [];
  const pending: any[] = [];
  for (const i of items) {
    if (i.status === "already") continue; // 已提交且无新增,本次不提交,无需准备
    if (i.status === "resolved" && i.work) {
      ready.push({ session: i.session, reason: i.reason ?? null, task: i.task ?? null, taskName: i.taskName ?? null, hours: i.hours ?? null, increment: !!i.increment });
      continue;
    }
    // pending: needs_semantic 或 resolved 缺 work(如增量补报无 summary-note)
    const submittedState = i.increment ? "increment" : "unsubmitted";
    const signals = sigMap?.[String(i.session)] ?? null; // daemon 预提取:turns(每轮结论)/commits/taskSubjects/prompts...
    pending.push({
      session: i.session,
      repo: i.repo,
      branch: i.branch,
      start: i.start,
      end: i.end,
      minutes: i.minutes,
      hours: i.hours,
      daemonSummary: i.summary ?? "",
      status: i.status, // needs_semantic | resolved
      submittedState,
      reason: i.reason ?? null,
      task: i.task ?? null, // increment 时沿用原提交任务
      taskName: i.taskName ?? null,
      candidates: i.candidates ?? [],
      signals, // daemon 预提取信号(优选素材);null=无(老会话未提取/daemon 不可达)
      transcript: signals ? null : extractTranscriptSignals(String(i.session), PROJECT_CWD), // 退化:现场直读 jsonl
    });
  }

  return {
    action: pending.length ? "prepare_needed" : "ready",
    date: plan.date,
    project: { repo: items[0]?.repo ?? path.basename(PROJECT_CWD), cwd: PROJECT_CWD },
    summary: { totalSessions: items.length, ready: ready.length, pending: pending.length },
    ready,
    pending,
    instructions:
      "对每个 pending:1) 生成 work(编号动宾,每条一个功能点)——signals 非空时以 turns 逐轮 conclusion 为主料、commits/taskSubjects 佐证、prompts 补意图;signals 为 null 时用 transcript.recentAssistantTexts+prompts+filesChanged;两者皆空退化 daemonSummary+filesChanged。2) 选 task——submittedState=increment 时沿用现有 task;needs_semantic 时从 candidates 选(置信度≥85 直定,<85 仍填 topCandidates 留 /report 确认);3) 调 note --session <id> --work <生成的work> --task <id> 写 summary。uncertain 可跳过。全 ready 后 /report 秒级提交。",
  };
}

function cmdMappings(a: Args): any {
  const mappings = loadJSON<any>(MAPPINGS_PATH, { repoToProject: {} });
  const names = mappings.projectNames || {};
  if (a["forget-repo"] !== undefined) {
    const repo = String(a["forget-repo"]);
    const existed = repo in mappings.repoToProject;
    delete mappings.repoToProject[repo];
    writeJSON(MAPPINGS_PATH, mappings);
    if (!existed) die(`映射不存在: ${repo}`);
  }
  return {
    repoToProject: Object.entries(mappings.repoToProject).map(([repo, pid]: [string, any]) => ({
      repo,
      project: pid,
      projectName: names[String(pid)] ?? null,
    })),
  };
}

function cmdLearn(a: Args): any {
  const mappings = existsSync(MAPPINGS_PATH)
    ? JSON.parse(readFileSync(MAPPINGS_PATH, "utf8"))
    : { repoToProject: {}, branchToTask: {} };
  if (a.repo && a.project) mappings.repoToProject[a.repo] = parseInt(String(a.project), 10);
  if (a.branch && a.task) mappings.branchToTask[`${a.repo}:${a.branch}`] = parseInt(String(a.task), 10);
  writeJSON(MAPPINGS_PATH, mappings);
  return mappings;
}

// ---------- 参数解析与分发 ----------
// collect 的分发见 main():它是本地命令(不登录禅道),与 render/config 同区。

const BOOL_FLAGS = new Set(["show", "all-status", "dry-run", "all", "on", "off"]);

function parseArgs(argv: string[]): Args {
  const cmd = argv[0];
  const a: Args = { cmd };
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith("--")) continue;
    const raw = t.slice(2);
    const eq = raw.indexOf("=");
    if (eq >= 0) {
      a[raw.slice(0, eq)] = raw.slice(eq + 1);
    } else if (BOOL_FLAGS.has(raw)) {
      a[raw] = true;
    } else {
      a[raw] = argv[++i]; // 取下一个 token 作为值,空串 "" 原样保留
    }
  }
  return a;
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  const cmd = a.cmd;
  if (!cmd) {
    die("用法: zentao.ts <命令> [参数],如 config/check/projects/my-tasks/plan/render/commit ...");
  }

  // 仅本地文件、不走网络的命令
  if (cmd === "render") {
    // plan.json 可能滞后于 summary(note 写 summary 后没重跑 plan,直接 render 会误报"尚有会话未完成归属"):
    // 有待归属/缺 work 条目时先纯本地重 plan 一次(note 已写齐的会转 resolved),重跑后仍缺才报错。
    const stale = loadJSON<any>(PLAN_PATH, null);
    const hasPending =
      stale &&
      Array.isArray(stale.items) &&
      stale.items.some((i: any) => i.status === "needs_semantic" || i.status === "unmatched" || (i.status === "resolved" && !i.work));
    if (hasPending) await cmdPlan(); // 无参 = source=cache,纯本地不联网
    console.log(cmdRender());
    return;
  }
  if (cmd === "collect") {
    const collected = await cmdCollect();
    console.log(JSON.stringify(collected, null, 2));
    // auto-note 挂点:hook 模式(Stop/SubagentStop/SessionStart 的 detached fork)、collect 成功、
    // stdin 带 session_id 时,顺带自动归纳该会话(纯本地+一次 daemon 精查,毫秒级;失败静默)。
    // SessionStart 早采集:新会话无 turn 天然无操作;resume 场景补记 resume 前漏的 turns。
    if (collected.mode === "hook" && collected.hookSessionId && !collected.skipped) {
      await autoNote(collected.hookSessionId);
    }
    return;
  }
  if (cmd === "config") {
    console.log(JSON.stringify(cmdConfig(a), null, 2));
    return;
  }
  if (cmd === "note") {
    cmdNote(a); // 静默记录(不输出"✓ 已记录"减少对话杂乱);失败时 cmdNote 内 die 已输出 error 并退出
    return;
  }
  if (cmd === "prepare") {
    console.log(JSON.stringify(await cmdPrepare(), null, 2));
    return;
  }
  if (cmd === "learn") {
    console.log(JSON.stringify(cmdLearn(a), null, 2));
    return;
  }
  if (cmd === "mappings") {
    console.log(JSON.stringify(cmdMappings(a), null, 2));
    return;
  }
  if (cmd === "mark") {
    console.log(JSON.stringify(cmdMark(a), null, 2));
    return;
  }

  // 走网络的命令
  const cfg = loadConfig();
  const client = new Client(cfg);
  await client.login(cfg);

  const source: "zentao" | "cache" = a.source === "cache" ? "cache" : "zentao";
  let out: any;
  if (cmd === "daily") {
    const from = (a.from as string) || todayISO();
    console.log(JSON.stringify(await writeReport(client, cfg, from, (a.to as string) || from, "daily", source), null, 2));
    return;
  }
  if (cmd === "weekly") {
    console.log(JSON.stringify(await writeReport(client, cfg, (a.from as string) || weekStart(), (a.to as string) || todayISO(), "weekly", source), null, 2));
    return;
  }
  if (cmd === "lastweek") {
    const [from, to] = lastWeekRange();
    console.log(JSON.stringify(await writeReport(client, cfg, from, to, "weekly", source), null, 2));
    return;
  }
  if (cmd === "check") {
    const user = (await client.get("/user")).profile || {};
    out = {
      ok: true,
      account: user.account ?? null,
      realname: user.realname ?? null,
      role: (isObj(user.role) ? (user.role as any).name : null) ?? null,
    };
  } else if (cmd === "projects") {
    const limit = a.limit !== undefined ? parseInt(String(a.limit), 10) : 100;
    // 默认只看进行中(left>0,剔除任务全完成的);--all 显示全部 involved(含已关闭)
    let list = await client.myProjects(limit);
    if (!a.all) list = list.filter((p: any) => p.status === "doing" && p.left > 0);
    if (a.search !== undefined) {
      const kw = String(a.search).toLowerCase();
      list = list.filter((p: any) => String(p.name).toLowerCase().includes(kw));
    }
    out = list;
  } else if (cmd === "my-tasks") {
    let pids: number[];
    if (a.projects) {
      pids = String(a.projects).split(",").map((x: string) => parseInt(x, 10));
    } else {
      pids =
        cfg.projectIds && cfg.projectIds.length
          ? cfg.projectIds
          : (await client.myProjects()).filter((p: any) => p.status === "doing").slice(0, 10).map((p: any) => p.id);
    }
    const statuses = a["all-status"] ? null : new Set(["doing", "wait"]);
    out = await client.myTasks(pids, statuses);
  } else if (cmd === "plan") {
    out = await cmdPlan(client, cfg, a.source === "zentao" ? "zentao" : "cache");
  } else if (cmd === "refresh") {
    const c = await getCache(client, cfg, true);
    out = {
      fetchedAt: c.fetchedAt,
      projects: c.projects.length,
      tasks: c.tasks.length,
      executions: c.executions.length,
    };
  } else if (cmd === "commit") {
    out = await cmdCommit(client, { dryRun: !!a["dry-run"] });
  } else if (cmd === "auto") {
    out = await cmdAuto(client, cfg, a);
  } else if (cmd === "amend") {
    out = await cmdCommit(client, { dryRun: !!a["dry-run"], amend: true });
  } else if (cmd === "efforts") {
    const taskId = requireInt(a, "task");
    const data = (await client.get(`/tasks/${taskId}/estimate`)).effort || {};
    const records: any[] = Array.isArray(data) ? data : Object.values(data);
    out = records
      .filter((r: any) => r.account === client.account && r.deleted === "0")
      .map((r: any) => ({
        effortId: r.id,
        date: r.date ?? null,
        consumed: r.consumed ?? null,
        left: r.left ?? null,
        work: r.work ?? null,
      }));
  } else if (cmd === "executions") {
    if (a.projects) {
      out = await client.executions(String(a.projects).split(",").map((x: string) => parseInt(x, 10)));
    } else {
      out = (await getCache(client, cfg)).executions;
    }
  } else if (cmd === "create-task") {
    const executionId = requireInt(a, "execution");
    const name = requireStr(a, "name");
    const estimate = parseFloat(String(a.estimate));
    out = await client.createTask(
      executionId,
      name,
      estimate,
      a.type !== undefined ? String(a.type) : "devel",
      a.desc !== undefined ? String(a.desc) : "",
    );
    const cache = loadJSON<any>(CACHE_PATH, null);
    if (cache !== null && out.created && out.task.id) {
      const ex = cache.executions?.find((e: any) => e.id === executionId) ?? null;
      cache.tasks.push({
        id: out.task.id,
        name,
        status: "wait",
        estimate,
        consumed: 0,
        left: estimate,
        project: ex ? (ex.project ?? null) : null,
        execution: executionId,
        executionName: ex ? (ex.name ?? null) : null,
      });
      writeJSON(CACHE_PATH, cache);
    }
  } else if (cmd === "submit") {
    const taskId = requireInt(a, "task");
    const date = requireStr(a, "date");
    const hours = parseFloat(String(a.hours));
    const work = applyMark(requireStr(a, "work"), loadMarkSetting());
    const left = a.left !== undefined ? parseFloat(String(a.left)) : null;
    out = await client.submitEffort(taskId, date, hours, work, left, !!a["dry-run"]);
    if (out.submitted) {
      if (a.session !== undefined) {
        out.recorded = recordSubmission(
          date,
          String(a.session),
          taskId,
          hours,
          a.minutes !== undefined ? parseInt(String(a.minutes), 10) : null,
        );
      }
      appendSubmittedLog({
        date,
        session: a.session !== undefined ? String(a.session) : "",
        cwd: PROJECT_CWD,
        repo: null, // 手动 submit 无 plan 上下文,展示字段从缺
        branch: null,
        start: null,
        end: null,
        minutes: a.minutes !== undefined ? parseInt(String(a.minutes), 10) : null,
        hours,
        task: taskId,
        taskName: out.task?.name ?? null,
        project: null,
        projectName: null,
        work, // 已 applyMark
      });
    }
  } else {
    die(`未知命令: ${cmd}`);
  }
  console.log(JSON.stringify(out, null, 2));
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
