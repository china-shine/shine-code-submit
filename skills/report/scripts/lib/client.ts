/** 禅道 REST API v1 客户端 + 任务缓存层。
 *  Client:三分错误处理(网络层 die / HTTP 非2xx throw 供重试 / 2xx→JSON)。
 *  getCache:本地缓存优先(TTL 过期自动刷新),首次或 refresh 才拉禅道。 */
import * as path from "node:path";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { die, roundPy, todayISO, isObj, nowISOSeconds, loadJSON, writeJSON, pad2, DATA_DIR, CACHE_PATH, EFFORTS_DIR } from "./shared";

export class Client {
  base: string;
  account: string;
  token = "";

  constructor(cfg: Record<string, any>) {
    this.base = cfg.url + "/api.php/v1";
    this.account = cfg.account;
  }

  async login(cfg: Record<string, any>): Promise<void> {
    const resp = await this._request("POST", "/tokens", {
      account: cfg.account,
      password: cfg.password,
    }, false);
    this.token = resp.token;
    if (!this.token) die("获取 token 失败,请检查账号密码");
  }

  /** 三分错误:网络层(含超时)→ die 退出;HTTP 非 2xx → throw 供调用方 catch 重试;2xx → JSON。 */
  async _request(method: string, p: string, body: unknown = null, auth = true): Promise<any> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "shine-worklog-Bun/0.1",
    };
    if (auth) headers["Token"] = this.token;
    const init: any = { method, headers, signal: AbortSignal.timeout(30000) };
    if (body !== null) init.body = JSON.stringify(body);
    let resp: Response;
    try {
      resp = await fetch(this.base + p, init);
    } catch (e) {
      die(`无法连接禅道服务器: ${e instanceof Error ? e.message : String(e)}`);
    }
    const text = await resp.text();
    if (!resp.ok) {
      // 挂结构化 status:供调用方区分「HTTP 拒绝(未成功处理,可安全重试)」vs「2xx 已成功但解析失败(重试会双写)」。
      const err = new Error(`${method} ${p} -> HTTP ${resp.status}: ${text.slice(0, 300)}`) as Error & { status?: number };
      err.status = resp.status;
      throw err;
    }
    try {
      return JSON.parse(text);
    } catch {
      // 2xx 但 body 非 JSON(HTML 错误页/空体/截断):服务器很可能已成功处理——绝不能在调用方按「旧版不兼容」重发。
      const err = new Error(`${method} ${p} -> 2xx 但响应非 JSON: ${text.slice(0, 100)}`) as Error & { status?: number };
      err.status = resp.status; // 2xx,<400
      throw err;
    }
  }

  async get(p: string): Promise<any> {
    return this._request("GET", p);
  }

  /** 全量 involved 项目(不限状态)——返回 status/left/lastEdited,由调用方按「进行中 或 近窗口有编辑」过滤。 */
  async myProjects(limit = 100): Promise<any[]> {
    const data = await this.get(`/projects?involved=1&limit=${limit}&order=lastEditedDate_desc`);
    return (data.projects || []).map((p: any) => ({
      id: p.id,
      name: p.name,
      status: p.status ?? null,
      left: Number(p.left) || 0,
      lastEdited: p.lastEditedDate ?? null,
    }));
  }

  /** 任务下「我」的工时记录(efforts),过滤 account=me + 未删除 */
  async myEfforts(taskId: number): Promise<any[]> {
    const data = (await this.get(`/tasks/${taskId}/estimate`)).effort || {};
    const records: any[] = Array.isArray(data) ? data : Object.values(data);
    return records
      .filter((r: any) => r.account === this.account && r.deleted === "0")
      .map((r: any) => ({ date: r.date ?? null, consumed: Number(r.consumed) || 0, work: r.work ?? "" }));
  }

  async myTasks(projectIds: number[], statuses: Set<string> | null, freshMs = 0): Promise<any[]> {
    const results: any[] = [];
    for (const pid of projectIds) {
      let execs: any[];
      try {
        execs = (await this.get(`/projects/${pid}/executions?limit=50`)).executions || [];
      } catch {
        continue;
      }
      for (const ex of execs) {
        // 执行:进行中全遍历;已关闭的只遍历「计划结束时间在窗口内」的(近期收尾才可能带最近工时;
        // 执行无 lastEditedDate,用 end 近似;老的关闭执行跳过,控住任务列表请求数)
        if (ex.status !== "doing") {
          const endMs = ex.end ? new Date(ex.end).getTime() : 0;
          if (!(freshMs && endMs >= freshMs)) continue;
        }
        let tasks: any[];
        try {
          tasks = (await this.get(`/executions/${ex.id}/tasks?limit=200`)).tasks || [];
        } catch {
          continue;
        }
        for (const t of tasks) {
          const at = t.assignedTo;
          const acc = isObj(at) ? (at as any).account : at;
          if (acc !== this.account) continue;
          if (statuses && !statuses.has(t.status)) continue;
          results.push({
            id: t.id,
            name: t.name,
            status: t.status,
            estimate: t.estimate ?? null,
            consumed: t.consumed ?? null,
            left: t.left ?? null,
            project: pid,
            execution: ex.id,
            executionName: ex.name ?? null,
            lastEditedDate: t.lastEditedDate ?? null,
          });
        }
      }
    }
    return results;
  }

  async executions(projectIds: number[]): Promise<any[]> {
    const results: any[] = [];
    for (const pid of projectIds) {
      let execs: any[];
      try {
        execs = (await this.get(`/projects/${pid}/executions?limit=50`)).executions || [];
      } catch {
        continue;
      }
      for (const ex of execs) {
        if (ex.status === "doing") {
          results.push({ id: ex.id, name: ex.name ?? null, project: pid, end: ex.end ?? null });
        }
      }
    }
    return results;
  }

  async createTask(executionId: number, name: string, estimate: number, taskType = "devel", desc = ""): Promise<any> {
    const today = todayISO();
    const payload: any = {
      name,
      type: taskType,
      assignedTo: [this.account],
      estimate,
      left: estimate,
      desc,
      estStarted: today,
      deadline: today,
    };
    let resp: any;
    try {
      resp = await this._request("POST", `/executions/${executionId}/tasks`, payload);
    } catch (e) {
      // 仅 HTTP 非 2xx(部分版本 assignedTo 只接受字符串→500)才降级;2xx 解析失败=服务器已创建,重发会双写。
      const status = (e as { status?: number })?.status;
      if (typeof status !== "number" || status < 400) throw e;
      payload.assignedTo = this.account; // 部分版本 assignedTo 只接受字符串
      resp = await this._request("POST", `/executions/${executionId}/tasks`, payload);
    }
    return {
      created: true,
      task: { id: resp.id ?? null, name: resp.name ?? null },
      execution: executionId,
      estimate,
    };
  }

  async submitEffort(taskId: number, date: string, hours: number, work: string, left: number | null = null, dryRun = false): Promise<any> {
    // left 由调用方(plan,读 cache 算好)传入时,从 cache 拿 task.name,省一次 GET /tasks/{id}(每条提交省 1 网络往返);
    // left 缺失才 GET(拿 task.left 算剩余 + name)。fallback:cache 无该 task 仍 GET 保底(不丢准确性)。
    let taskName: string | null = null;
    if (left === null || left === undefined) {
      const task = await this.get(`/tasks/${taskId}`);
      left = Math.max(roundPy(Number(task.left ?? 0) - hours, 1), 0);
      taskName = task.name ?? null;
    } else {
      const t = (loadJSON<any>(CACHE_PATH, null)?.tasks ?? []).find((x: any) => x.id === taskId);
      taskName = t?.name ?? null;
      if (taskName === null) taskName = (await this.get(`/tasks/${taskId}`)).name ?? null; // cache 无该 task,fallback GET
    }
    const payload: any = { date: [date], work: [work], consumed: [hours], left: [left] };
    const legacy: any = { id: [0], objectID: [taskId], dates: [date], work: [work], consumed: [hours], left: [left], objectType: ["task"] };
    if (dryRun) {
      return {
        dryRun: true,
        task: { id: taskId, name: taskName },
        endpoint: `POST /tasks/${taskId}/estimate`,
        payload,
      };
    }
    let resp: any;
    try {
      resp = await this._request("POST", `/tasks/${taskId}/estimate`, payload);
    } catch (e) {
      // 仅 HTTP 非 2xx(旧版禅道对新 body 返回 500)才降级 legacy;2xx 解析失败=服务器已记录,重发会双写,必须 rethrow。
      const status = (e as { status?: number })?.status;
      if (typeof status !== "number" || status < 400) throw e;
      resp = await this._request("POST", `/tasks/${taskId}/estimate`, legacy); // 禅道 < 20.7 旧版请求体
    }
    return {
      submitted: true,
      task: { id: taskId, name: taskName },
      consumed: resp.consumed ?? null,
      left: resp.left ?? null,
    };
  }
}

/** efforts 缓存滚动窗口(天):refresh 只拉「未完成全部 + 近 N 天完成的」任务,记录也只保留近 N 天——
 *  缓存大小恒定(daily/weekly cache 源足够,覆盖 lastweek 回看);更早历史用禅道实时源。 */
const EFFORT_FRESH_DAYS = 20;

/** 纯读本地禅道缓存,不传 client/不联网。prepare 用它保证「绝不联网」契约;返回 null 表示尚未缓存。 */
export function getCacheLocal(): any | null {
  return loadJSON<any>(CACHE_PATH, null);
}

async function getCache(client: Client, cfg: Record<string, any>, refresh = false): Promise<any> {
  // 有本地缓存就直接复用(不管是否过期)——/report/daily/weekly 读本地秒回,绝不拉禅道;
  // 禅道更新由 dashboard「更新禅道」按钮(POST /api/zentao-cache/refresh)或显式 refresh 触发。
  // 仅首次(无缓存)或 refresh=true 才拉禅道。
  const existing = getCacheLocal();
  if (existing !== null && !refresh) {
    // TTL 过期自动刷新:过期则继续联网拉(自动刷新),未过期秒回
    const ttl = Number(loadJSON<any>(path.join(DATA_DIR, "settings.json"), {}).zentaoCacheTtlMin) || 0;
    const fa = (existing as any).fetchedAt;
    const expired = ttl > 0 && (typeof fa !== "string" || (Date.now() - new Date(fa).getTime()) / 60000 > ttl);
    if (!expired) return existing;
    // TTL 过期:继续往下联网拉(自动刷新)
  }
  // 滚动窗口基准:近 EFFORT_FRESH_DAYS 天。项目/执行/任务/记录四层同窗口——
  // 「与近 20 天工时关联的都要拉」:项目按状态/最近编辑、执行按状态/计划结束、任务按状态/最近编辑、记录按日期。
  const cutoffD = new Date(Date.now() - EFFORT_FRESH_DAYS * 86400_000);
  const cutoffDate = `${cutoffD.getFullYear()}-${pad2(cutoffD.getMonth() + 1)}-${pad2(cutoffD.getDate())}`;
  const freshMs = cutoffD.getTime();
  const editedRecently = (x: any) => {
    const ts = new Date(x?.lastEditedDate ?? x?.lastEdited ?? 0).getTime();
    return Number.isFinite(ts) && ts > 0 && ts >= freshMs;
  };
  // 项目:进行中(doing 且还有剩余工时)或近窗口有编辑(可能带最近工时收尾的已关闭/挂起项目);
  // 配了 projectIds 只留 setup 选的「属于自己的」项目。
  console.error("  [1/4] 拉项目...");
  const allProjects = await client.myProjects(1000);
  const projects = allProjects
    .filter((p: any) => (p.status === "doing" && p.left > 0) || editedRecently(p))
    .filter((p: any) => !cfg.projectIds?.length || cfg.projectIds.includes(p.id));
  const pids = projects.map((p: any) => p.id);
  // 任务:未完成(doing/wait)全拉 + 已完成(done/closed)只拉「近 EFFORT_FRESH_DAYS 天有编辑」的
  // ——已完成任务的工时也要进 efforts 缓存,否则任务一旦完成,日报/周报 cache 源就漏它的工时(#78500 案例);
  // 但已完成任务随时间无限增长(每任务一次 GET),按最近编辑时间开窗,缓存恒为「最近 N 天」滚动窗口。
  // cache.tasks 仍只留未完成(plan 匹配候选/pendingTasks 语义不变);已完成任务只拉 efforts + 记 taskDetails(名称/项目,报表解析不联网)。
  // 窗口外的更早历史要看准 → 禅道实时源;任务不指派给我的始终拉不到,同样靠实时源兜底。
  console.error(`  [2/4] 拉任务(${pids.length} 项目,含近 ${EFFORT_FRESH_DAYS} 天完成的)...`);
  const allTasks = await client.myTasks(pids, null, freshMs);
  const unfinished = (t: any) => t.status === "doing" || t.status === "wait";
  const tasks = allTasks.filter(unfinished);
  const doneTasks = allTasks.filter((t: any) => !unfinished(t) && editedRecently(t));
  const effortTasks = [...tasks, ...doneTasks];
  // 拉每个任务的工时记录(effort:每天 consumed + work 总结),供 daily/weekly cache 源不联网;
  // 只保留窗口内(>=cutoffDate)的记录——无日期记录报表本就不展示,一并滤掉。
  console.error(`  [3/4] 拉工时记录(${effortTasks.length} 任务,并行)...`);
  const taskEfforts: Record<number, { date: string | null; consumed: number; work: string }[]> = {};
  await Promise.all(effortTasks.map(async (t: any) => {
    try {
      taskEfforts[t.id] = (await client.myEfforts(t.id)).filter((r: any) => r.date && r.date >= cutoffDate);
    } catch { /* 单个任务拉失败跳过,不阻塞整体 */ }
  }));
  console.error("  [4/4] 拉执行 + 写本地缓存...");
  const executions = await client.executions(pids);
  // 已完成任务记入 taskDetails(报表 cache 源解析任务名/项目免联网 GET);
  // 与 efforts 同窗口:只保留当前拉取集合(未完成 ∪ 近 N 天完成)内的旧条目,窗口外的一并修剪,不随时间累积。
  const effortIds = new Set(effortTasks.map((t: any) => t.id));
  const taskDetails: Record<string, any> = {};
  for (const [k, v] of Object.entries(existing?.taskDetails ?? {})) {
    if (effortIds.has(Number(k))) taskDetails[k] = v; // submit 落下的名称缓存仍在集合内的保留
  }
  for (const t of doneTasks) taskDetails[String(t.id)] = { name: t.name, project: t.project };
  // 主 cache(元数据,稳定小):不含 taskEfforts(增长大头,拆到 efforts/<taskId>.json)
  const cache = {
    fetchedAt: nowISOSeconds(),
    projects,
    tasks,
    executions,
    taskDetails,
  };
  writeJSON(CACHE_PATH, cache);
  // 工时记录按任务拆分存(每任务独立文件,增长隔离,避免 cache.json 越来越大)
  mkdirSync(EFFORTS_DIR, { recursive: true });
  for (const t of effortTasks) {
    // 拉取失败(网络抖动)的任务不写:避免用空数组覆盖旧快照,丢窗口数据到下次 refresh
    if (taskEfforts[t.id] === undefined) continue;
    writeJSON(path.join(EFFORTS_DIR, `${t.id}.json`), { taskId: t.id, fetchedAt: cache.fetchedAt, efforts: taskEfforts[t.id] });
  }
  // 修剪:不在本次拉取集合的旧文件(窗口外任务的残留快照),记录按窗口过滤,全过期则删文件
  // ——efforts/ 恒为「最近 N 天」滚动窗口,不随使用时间无限膨胀。
  // 损坏文件(半个 JSON,如写入中途被杀)按可修剪处理直接删,不能让 refresh 崩掉。
  for (const f of readdirSync(EFFORTS_DIR)) {
    if (!f.endsWith(".json")) continue;
    const p = path.join(EFFORTS_DIR, f);
    let e: any;
    try {
      e = loadJSON<any>(p, null);
    } catch {
      try { rmSync(p); } catch { /* 删除失败(文件被占)留到下次 */ }
      continue;
    }
    if (!e || e.taskId == null || effortIds.has(e.taskId)) continue;
    const kept = (e.efforts ?? []).filter((r: any) => r.date && r.date >= cutoffDate);
    if (kept.length === 0) {
      try { rmSync(p); } catch { /* 删除失败(文件被占)留到下次 */ }
    } else {
      writeJSON(p, { ...e, efforts: kept });
    }
  }
  return { ...cache, taskEfforts }; // 返回仍含 taskEfforts(内存,兼容 cmdPlan 等用 cache.tasks 的调用方)
}
export { getCache };
