#!/usr/bin/env bun
/** 禅道 REST API v1 客户端(ZenPilot 工时填报 skill 使用)— Bun + TypeScript 版。
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
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { Args, die, loadJSON, writeJSON, roundPy, todayISO, nowISOSeconds, minutesSinceISO, hoursFromMinutes, fmtHours, isObj, loadConfig, loadMarkSetting, applyMark, requireStr, requireInt, summaryPathFor, CONFIG_PATH, CACHE_PATH, MAPPINGS_PATH, SETTINGS_PATH, SESSIONS_PATH, SUBMITTED_PATH, PLAN_PATH, PROJECT_DIR, PROJECT_CWD, COMMIT_COOLDOWN_MINUTES } from "./lib/shared";
import { Client, getCache, getCacheLocal } from "./lib/client";
import { cmdCollect, extractTranscriptSignals } from "./lib/transcript";
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
 *  cmdPlan summary 拆段 + increment 过滤共用(同文件真共享,消除水位 filter 散落)。
 *  detectAndRemind 在 main.ts 因零依赖隔离,内联同款 filter + 注释关联此处。 */
function waterNotes(notes: any[]): any[] {
  return notes
    .filter((n: any) => n && typeof n.notedActiveMinutes === "number")
    .sort((a: any, b: any) => (Number(a.notedActiveMinutes) || 0) - (Number(b.notedActiveMinutes) || 0));
}

export async function cmdPlan(client?: Client, cfg?: Record<string, any>): Promise<any> {
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
  // client 缺省(prepare 路径)走纯本地缓存不联网;调用方(cmdPrepare)须预检 cache 存在
  const cache = client ? await getCache(client, cfg!) : getCacheLocal();
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
        writeJSON(CACHE_PATH, cache);
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
  for (const fn of readdirSync(PROJECT_DIR)) {
    if (!/^summary-\d{4}-\d{2}-\d{2}\.json$/.test(fn)) continue;
    for (const sn of loadJSON<any[]>(path.join(PROJECT_DIR, fn), [])) {
      if (!sn || !sn.session) continue;
      const arr = notesBySession.get(sn.session) ?? [];
      arr.push(sn);
      notesBySession.set(sn.session, arr);
    }
  }
  for (const s of data.sessions) {
    const item: any = {
      session: s.id,
      repo: s.repo,
      branch: s.branch,
      start: s.start,
      end: s.end,
      minutes: s.activeMinutes,
      summary: s.summary ?? "",
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
        // 增量补报:task 沿用原提交;work 优先取该会话的 summary-note(若有),免去 AI 填空,
        // 让 auto 一键能跑通;无 summary-note 则留 null,由 auto/render 的缺 work 检查拦下
        const incNotes = notesBySession.get(s.id) || [];
        // 增量 work 只用"上次提交水位(含)之后"记的新 note(notedActiveMinutes >= rec.minutes,含==防 sessions 滞后导致 work=null);
        // 无新 note → null(让 auto/render 的缺 work 检查拦下 AI 填),不退化用已提交的旧 note(避免陈旧文案)
        const submittedMin = rec.minutes ?? 0;
        const newIncNotes = waterNotes(incNotes).filter((n: any) => (Number(n.notedActiveMinutes) || 0) >= submittedMin);
        Object.assign(
          item,
          {
            status: "resolved",
            increment: true,
            task: taskId,
            hours: hoursFromMinutes(delta),
            confidence: 95,
            reason: "已提交会话的增量补报,沿用原任务",
            work: newIncNotes.length ? newIncNotes.map((n: any) => n.work).join("\n") : null,
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
        for (let i = 0; i < wn.length; i++) {
          const n = wn[i];
          if (!n) continue;
          const w = Math.max(0, Math.min(total, Number(n.notedActiveMinutes) || 0)); // clamp 到 [0,total]
          const isLast = i === wn.length - 1;
          const segEnd = isLast ? total : w; // 末条尾部归该 task(延续到现在)
          const segment = Math.max(0, segEnd - prev);
          prev = w; // 推进水位(即便本段=0 被跳过,下一条仍以 w 为起点)
          if (segment < 1) continue; // 跳过 0 段(同分钟多 note)
          const info = n.taskName
            ? { taskName: n.taskName, project: n.project, projectName: n.projectName }
            : await taskInfo(n.task);
          items.push({
            ...item,
            status: "resolved",
            task: n.task,
            work: n.work, // 单条 note 自己的 work(不 join)
            hours: hoursFromMinutes(segment),
            minutes: segEnd, // 该段末水位:recordSubmission 据此写防重水位(部分提交失败时不掩盖后续 task 工时)
            confidence: 100,
            reason: "开发时 summary 记录(多 note 按水位拆分)",
            ...info,
          });
        }
        continue;
      }
      // 退化:有 note 但缺水位(老数据) → 单 item(join 所有 work、n0.task、整 session hours)
      const n0 = notes[0];
      const info = n0.taskName
        ? { taskName: n0.taskName, project: n0.project, projectName: n0.projectName }
        : await taskInfo(n0.task);
      Object.assign(
        item,
        {
          status: "resolved",
          task: n0.task,
          work: notes.map((n: any) => n.work).join("\n"),
          hours: hoursFromMinutes(s.activeMinutes),
          confidence: 100,
          reason: "开发时 summary 记录",
        },
        info,
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
      const cands = tasks.filter((t: any) => pid == null || t.project === pid);
      Object.assign(item, {
        status: "needs_semantic",
        reason: pid != null ? `仓库映射到项目 ${pid},候选已收窄` : "无仓库映射,候选为全部任务",
        candidates: cands.map((t: any) => ({
          id: t.id,
          name: t.name,
          project: t.project,
          projectName: projectNames[t.project] ?? null,
        })),
      });
    }
    items.push(item);
  }

  // 顺手刷新本地项目名缓存,供 mappings 离线查看
  mappings.projectNames = {};
  for (const [k, v] of Object.entries(projectNames)) mappings.projectNames[String(k)] = v;
  writeJSON(MAPPINGS_PATH, mappings);

  const plan = { date, draftSeq: 0, items };
  writeJSON(PLAN_PATH, plan);
  // cooldown 预判:返回给调用方(SKILL 据此决定是否 render/commit,避免 commit 失败再查)
  const cdMeta = (submittedAll[date] || {})._meta || {};
  let cooldown: { waitMinutes: number; lastCommitAt: string } | null = null;
  if (cdMeta.lastCommitAt) {
    const elapsed = minutesSinceISO(cdMeta.lastCommitAt);
    if (elapsed < COMMIT_COOLDOWN_MINUTES) {
      cooldown = { waitMinutes: Math.trunc(COMMIT_COOLDOWN_MINUTES - elapsed) + 1, lastCommitAt: cdMeta.lastCommitAt };
    }
  }
  return { ...plan, cooldown };
}

function cmdRender(): string {
  const plan = loadJSON<any>(PLAN_PATH, null);
  if (plan === null) die(`计划不存在,请先运行 plan 命令: ${PLAN_PATH}`);
  const items = plan.items;
  const pending = items.filter((i: any) => i.status === "needs_semantic").map((i: any) => i.session);
  if (pending.length) die("尚有会话未完成归属(needs_semantic),补全后才能渲染草稿", { sessions: pending });
  const noWork = items.filter((i: any) => i.status === "resolved" && !i.work).map((i: any) => i.session);
  if (noWork.length) die("以下 resolved 条目缺少 work 字段(工作内容)", { sessions: noWork });
  plan.draftSeq = (plan.draftSeq ?? 0) + 1;
  writeJSON(PLAN_PATH, plan);

  const lines: string[] = [
    `今日工时草稿 #ZR-${plan.date.replace(/-/g, "")}-${String(plan.draftSeq).padStart(3, "0")}`,
    "",
  ];
  let n = 0;
  for (const i of items) {
    if (i.status !== "resolved") continue;
    n++;
    const inc = i.increment ? "(增量)" : "";
    lines.push(
      `[${n}] ${i.projectName || i.repo}(项目#${i.project}) / ${i.taskName || "?"}(任务#${i.task})`,
      `    ${i.start}—${i.end},${fmtHours(i.hours)}小时${inc}`,
      `    内容:${i.work}`,
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
        `[·] ${i.repo}/${i.branch} ${i.start}—${i.end},${fmtHours(i.hours || hoursFromMinutes(i.minutes))}小时 — ${i.skipReason || "用户选择跳过"}`,
      );
    }
    lines.push("");
  }
  const already = items.filter((i: any) => i.status === "already");
  if (already.length) {
    lines.push("已提交(本次不再提交):");
    for (const i of already) {
      lines.push(`[·] ${i.taskName || ""}(任务#${i.task}) ${fmtHours(i.submittedHours)}小时 — 会话 ${i.session}`);
    }
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

/** 提交冷却检查:距上次 commit < COMMIT_COOLDOWN_MINUTES 返回 {waitMinutes, lastCommitAt, elapsed},否则 null。cmdCommit(die)+cmdAuto(return)共用,消除冷却逻辑复制。 */
function checkCooldown(date: string): { waitMinutes: number; lastCommitAt: string; elapsed: number } | null {
  const meta = (loadJSON<any>(SUBMITTED_PATH, {})[date] || {})._meta || {};
  if (!meta.lastCommitAt) return null;
  const elapsed = minutesSinceISO(meta.lastCommitAt);
  if (elapsed >= COMMIT_COOLDOWN_MINUTES) return null;
  return { waitMinutes: Math.trunc(COMMIT_COOLDOWN_MINUTES - elapsed) + 1, lastCommitAt: meta.lastCommitAt, elapsed };
}

async function cmdCommit(client: Client, opts: { dryRun?: boolean; amend?: boolean }): Promise<any> {
  const dryRun = !!opts.dryRun;
  const amend = !!opts.amend;
  const plan = loadJSON<any>(PLAN_PATH, null);
  if (plan === null) die(`计划不存在,请先运行 plan 命令: ${PLAN_PATH}`);
  const items = plan.items;
  const pending = items.filter((i: any) => i.status === "needs_semantic").map((i: any) => i.session);
  if (pending.length) die("尚有会话未完成归属,不能提交", { sessions: pending });
  const toSubmit = items.filter((i: any) => i.status === "resolved");
  const noWork = toSubmit.filter((i: any) => !i.work).map((i: any) => i.session);
  if (noWork.length) die("以下条目缺少 work 字段,不能提交", { sessions: noWork });
  const meta = (loadJSON<any>(SUBMITTED_PATH, {})[plan.date] || {})._meta || {};
  if (amend) {
    if (!meta.lastCommit) die("没有可修正的提交:今天还没有 commit 记录");
    const allowed = new Set(meta.lastCommit.map((e: any) => e.session));
    const extra = toSubmit.filter((i: any) => !allowed.has(i.session)).map((i: any) => i.session);
    if (extra.length) {
      die("amend 只能修正最后一次提交包含的会话,其余条目请改回 skipped 或等冷却后走 commit", {
        sessions: extra,
        lastCommitSessions: [...allowed].sort(),
      });
    }
  } else if (toSubmit.length && !dryRun) {
    const cd = checkCooldown(plan.date);
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
    let out: any;
    try {
      out = await client.submitEffort(i.task, plan.date, i.hours, applyMark(i.work, mark), i.left ?? null, dryRun);
    } catch (e) {
      out = { submitted: false, error: e instanceof Error ? e.message : String(e) }; // 单条失败不崩,继续其他条目
    }
    if (out.submitted) {
      recordSubmission(plan.date, i.session, i.task, i.hours, i.minutes);
      if (i.project) {
        mappings.repoToProject[i.repo] = i.project;
        if (i.projectName) {
          if (!mappings.projectNames) mappings.projectNames = {};
          mappings.projectNames[String(i.project)] = i.projectName;
        }
      }
    }
    results.push({ session: i.session, hours: i.hours, ...out });
  }
  const ok = results.filter((r: any) => r.submitted);
  if (!dryRun) {
    writeJSON(MAPPINGS_PATH, mappings);
    if (ok.length) {
      const log = loadJSON<any>(SUBMITTED_PATH, {});
      if (!log[plan.date]) log[plan.date] = {};
      const day = log[plan.date];
      const entries = ok.map((r: any) => ({ session: r.session, task: r.task.id, hours: r.hours }));
      if (amend && day._meta) {
        day._meta.amendedAt = nowISOSeconds();
        day._meta.lastCommit = day._meta.lastCommit.concat(entries);
      } else {
        day._meta = { lastCommitAt: nowISOSeconds(), lastCommit: entries };
      }
      writeJSON(SUBMITTED_PATH, log);
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
  const pending = items.filter((i: any) => i.status === "needs_semantic").map((i: any) => i.session);
  if (pending.length) return { action: "needs_review", reason: "有 needs_semantic 需 AI 填空", pending, plan };
  const toSubmit = items.filter((i: any) => i.status === "resolved");
  const noWork = toSubmit.filter((i: any) => !i.work).map((i: any) => i.session);
  if (noWork.length) return { action: "needs_review", reason: "有 resolved 缺 work", noWork, plan };
  // 提交冷却:复制 cmdCommit 的检查,return 而非 die
  if (toSubmit.length && !dryRun) {
    const cd = checkCooldown(plan.date);
    if (cd) return { action: "cooldown", lastCommitAt: cd.lastCommitAt, waitMinutes: cd.waitMinutes };
  }
  const draft = cmdRender();
  if (toSubmit.length === 0) return { action: "nothing", draft, plan };
  const result = await cmdCommit(client, { dryRun });
  return { action: "committed", draft, result };
}

/** 开发时记一条功能总结到 summary-YYYY-MM-DD.json(按项目+日期)。
 *  work=功能点编号文案, task=禅道任务ID, session 未传则取当天最新活跃会话。
 *  自动从 cache.json 补 taskName/project/projectName。/report plan 直读省 AI 填空。 */
function cmdNote(a: Args): any {
  const work = requireStr(a, "work");
  const task = requireInt(a, "task");
  let session = a.session !== undefined ? String(a.session) : undefined;
  if (!session) {
    const data = loadJSON<{ sessions: any[] }>(SESSIONS_PATH, { sessions: [] });
    const sessions = Array.isArray(data.sessions) ? data.sessions : [];
    if (sessions.length === 0) die(`未指定 --session 且无当天会话数据(先 collect): ${SESSIONS_PATH}`);
    // 取 end 最晚的(最新活跃);end 是 "HH:MM" 字符串,字符串排序即时间序
    const latest = [...sessions].sort((x, y) => String(y.end ?? "").localeCompare(String(x.end ?? "")))[0];
    session = latest?.id;
    if (!session) die("无法从当天会话推断 session,请显式传 --session");
  }
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
  list.push({ session, ts: nowISOSeconds(), work, task, taskName, project, projectName, notedActiveMinutes });
  writeJSON(smp, list);
  return { ok: true, file: smp, session, entries: list.length };
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
      transcript: extractTranscriptSignals(String(i.session), PROJECT_CWD),
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
      "对每个 pending:1) 据 transcript.recentAssistantTexts+prompts+filesChanged 生成 work(编号动宾,每条一个功能点);2) 选 task——submittedState=increment 时沿用现有 task;needs_semantic 时从 candidates 选(置信度≥85 直定,<85 仍填 topCandidates 留 /report 确认);3) 调 note --session <id> --work <生成的work> --task <id> 写 summary。uncertain 可跳过。全 ready 后 /report 秒级提交。",
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
    console.log(cmdRender());
    return;
  }
  if (cmd === "collect") {
    console.log(JSON.stringify(await cmdCollect(), null, 2));
    return;
  }
  if (cmd === "config") {
    console.log(JSON.stringify(cmdConfig(a), null, 2));
    return;
  }
  if (cmd === "note") {
    console.log(JSON.stringify(cmdNote(a), null, 2));
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

  let out: any;
  if (cmd === "daily") {
    const from = (a.from as string) || todayISO();
    console.log(JSON.stringify(await writeReport(client, cfg, from, (a.to as string) || from, "daily"), null, 2));
    return;
  }
  if (cmd === "weekly") {
    console.log(JSON.stringify(await writeReport(client, cfg, (a.from as string) || weekStart(), (a.to as string) || todayISO(), "weekly"), null, 2));
    return;
  }
  if (cmd === "lastweek") {
    const [from, to] = lastWeekRange();
    console.log(JSON.stringify(await writeReport(client, cfg, from, to, "weekly"), null, 2));
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
    let list = await client.myProjects(limit, !a.all); // 默认一层过滤(left>0,剔除任务全完成);--all 显示全部
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
          : (await client.myProjects()).slice(0, 10).map((p: any) => p.id);
    }
    const statuses = a["all-status"] ? null : new Set(["doing", "wait"]);
    out = await client.myTasks(pids, statuses);
  } else if (cmd === "plan") {
    out = await cmdPlan(client, cfg);
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
    if (out.submitted && a.session !== undefined) {
      out.recorded = recordSubmission(
        date,
        String(a.session),
        taskId,
        hours,
        a.minutes !== undefined ? parseInt(String(a.minutes), 10) : null,
      );
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
