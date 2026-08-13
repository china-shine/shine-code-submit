/** 禅道 REST API v1 客户端 + 任务缓存层。
 *  Client:三分错误处理(网络层 die / HTTP 非2xx throw 供重试 / 2xx→JSON)。
 *  getCache:本地缓存优先(TTL 过期自动刷新),首次或 refresh 才拉禅道。 */
import * as path from "node:path";
import { mkdirSync } from "node:fs";
import { die, roundPy, todayISO, isObj, nowISOSeconds, loadJSON, writeJSON, DATA_DIR, CACHE_PATH, EFFORTS_DIR } from "./shared";

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
      throw new Error(`${method} ${p} -> HTTP ${resp.status}: ${text.slice(0, 300)}`);
    }
    return JSON.parse(text);
  }

  async get(p: string): Promise<any> {
    return this._request("GET", p);
  }

  async myProjects(limit = 100, filterActive = false): Promise<any[]> {
    const data = await this.get(`/projects?involved=1&status=doing&limit=${limit}&order=lastEditedDate_desc`);
    let raw: any[] = data.projects || [];
    if (filterActive) {
      // 一层过滤:剔除任务全完成的项目(剩余工时 left=0),零额外请求
      raw = raw.filter((p: any) => Number(p.left) > 0);
    }
    return raw.map((p: any) => ({
      id: p.id,
      name: p.name,
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

  async myTasks(projectIds: number[], statuses: Set<string> | null): Promise<any[]> {
    const results: any[] = [];
    for (const pid of projectIds) {
      let execs: any[];
      try {
        execs = (await this.get(`/projects/${pid}/executions?limit=50`)).executions || [];
      } catch {
        continue;
      }
      for (const ex of execs) {
        if (ex.status !== "doing") continue;
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
    } catch {
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
    } catch {
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
  // 项目:involved 进行中 + left>0(活跃,剔除任务全完成的历史项目);配了 projectIds 只留 setup 选的「属于自己的」项目。
  console.error("  [1/4] 拉项目...");
  const allProjects = await client.myProjects(1000, true);
  const projects = cfg.projectIds && cfg.projectIds.length
    ? allProjects.filter((p: any) => cfg.projectIds.includes(p.id))
    : allProjects;
  const pids = projects.map((p: any) => p.id);
  // 任务:只未完成(doing/wait),已 done/closed 的不拉(不会提交工时,减 cache 噪音)。
  console.error(`  [2/4] 拉未完成任务(${pids.length} 项目)...`);
  const tasks = await client.myTasks(pids, new Set(["doing", "wait"]));
  // 拉每个未完成任务的工时记录(effort:每天 consumed + work 总结),供 daily/weekly/防重读 cache 不联网。
  console.error(`  [3/4] 拉工时记录(${tasks.length} 任务,并行)...`);
  const taskEfforts: Record<number, { date: string | null; consumed: number; work: string }[]> = {};
  await Promise.all(tasks.map(async (t: any) => {
    try { taskEfforts[t.id] = await client.myEfforts(t.id); } catch { /* 单个任务拉失败跳过,不阻塞整体 */ }
  }));
  console.error("  [4/4] 拉执行 + 写本地缓存...");
  const executions = await client.executions(pids);
  // 主 cache(元数据,稳定小):不含 taskEfforts(增长大头,拆到 efforts/<taskId>.json)
  const cache = {
    fetchedAt: nowISOSeconds(),
    projects,
    tasks,
    executions,
    taskDetails: existing?.taskDetails ?? {},
  };
  writeJSON(CACHE_PATH, cache);
  // 工时记录按任务拆分存(每任务独立文件,增长隔离,避免 cache.json 越来越大)
  mkdirSync(EFFORTS_DIR, { recursive: true });
  for (const t of tasks) {
    writeJSON(path.join(EFFORTS_DIR, `${t.id}.json`), { taskId: t.id, fetchedAt: cache.fetchedAt, efforts: taskEfforts[t.id] ?? [] });
  }
  return { ...cache, taskEfforts }; // 返回仍含 taskEfforts(内存,兼容 cmdPlan 等用 cache.tasks 的调用方)
}
export { getCache };
