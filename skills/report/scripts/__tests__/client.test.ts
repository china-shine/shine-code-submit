import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { Client } from "../lib/client";

const realFetch = globalThis.fetch;
type Handler = (url: string, init: any) => { status: number; body: any };
let handler: Handler | null = null;

beforeEach(() => {
  handler = null;
  globalThis.fetch = mock(async (input: any, init: any) => {
    const url = typeof input === "string" ? input : (input?.url ?? String(input));
    if (!handler) throw new Error("no mock handler set");
    const { status, body } = handler(url, init || {});
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as any;
});
afterEach(() => { globalThis.fetch = realFetch; });

const use = (h: Handler) => { handler = h; };
const cli = (account = "me") => new Client({ url: "https://zentao", account });

describe("login", () => {
  test("POST /tokens 取 token", async () => {
    use((url, init) => {
      expect(url).toContain("/tokens");
      expect(init.method).toBe("POST");
      return { status: 200, body: { token: "abc" } };
    });
    const c = cli();
    await c.login({ account: "me", password: "p" });
    expect(c.token).toBe("abc");
  });
  test("token 空 → die", async () => {
    use(() => ({ status: 200, body: { token: "" } }));
    const log = spyOn(console, "log").mockImplementation(() => {});
    const exit = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT_${code ?? 0}`);
    }) as never);
    await expect(cli().login({ account: "me", password: "p" })).rejects.toThrow("EXIT_1");
    log.mockRestore();
    exit.mockRestore();
  });
});

describe("_request 三分错误", () => {
  test("网络层 throw → die", async () => {
    globalThis.fetch = mock(async () => { throw new TypeError("network fail"); }) as any;
    const log = spyOn(console, "log").mockImplementation(() => {});
    const exit = spyOn(process, "exit").mockImplementation(((c?: number) => { throw new Error(`EXIT_${c ?? 0}`); }) as never);
    await expect(cli().get("/x")).rejects.toThrow("EXIT_1");
    log.mockRestore();
    exit.mockRestore();
  });
  test("HTTP 非2xx → throw(供 catch 重试)", async () => {
    use(() => ({ status: 500, body: { error: "boom" } }));
    await expect(cli().get("/x")).rejects.toThrow(/HTTP 500/);
  });
});

describe("myProjects", () => {
  test("filterActive 剔除 left=0", async () => {
    use((url) => {
      expect(url).toContain("/projects?involved=1&status=doing");
      return { status: 200, body: { projects: [
        { id: 1, name: "P1", left: 5, lastEditedDate: "2026-08-01" },
        { id: 2, name: "P2", left: 0, lastEditedDate: "2026-08-02" },
      ] } };
    });
    const list = await cli().myProjects(100, true);
    expect(list).toEqual([{ id: 1, name: "P1", lastEdited: "2026-08-01" }]);
  });
  test("不过滤保留全部", async () => {
    use(() => ({ status: 200, body: { projects: [
      { id: 1, name: "P1", left: 5 }, { id: 2, name: "P2", left: 0 },
    ] } }));
    const list = await cli().myProjects(100, false);
    expect(list.map((p) => p.id)).toEqual([1, 2]);
  });
});

describe("myEfforts", () => {
  test("过滤 account=me + deleted=0", async () => {
    use((url) => {
      expect(url).toContain("/tasks/10/estimate");
      return { status: 200, body: { effort: {
        a: { account: "me", deleted: "0", date: "2026-08-06", consumed: "1.5", work: "a" },
        b: { account: "other", deleted: "0", date: "2026-08-05", consumed: "2", work: "b" },
        c: { account: "me", deleted: "1", date: "2026-08-04", consumed: "3", work: "c" },
      } } };
    });
    const r = await cli().myEfforts(10);
    expect(r).toEqual([{ date: "2026-08-06", consumed: 1.5, work: "a" }]);
  });
});

describe("myTasks", () => {
  test("遍历项目→执行→任务,assignedTo + status 过滤", async () => {
    use((url) => {
      if (url.includes("/projects/5/executions"))
        return { status: 200, body: { executions: [
          { id: 20, status: "doing", name: "S1" }, { id: 21, status: "closed", name: "S2" },
        ] } };
      if (url.includes("/executions/20/tasks"))
        return { status: 200, body: { tasks: [
          { id: 100, name: "T1", status: "doing", assignedTo: { account: "me" }, estimate: 10, consumed: 2, left: 8 },
          { id: 101, name: "T2", status: "doing", assignedTo: { account: "other" } },
          { id: 102, name: "T3", status: "wait", assignedTo: "me" },
        ] } };
      throw new Error("unexpected " + url);
    });
    const r = await cli().myTasks([5], new Set(["doing", "wait"]));
    expect(r.map((t) => t.id).sort()).toEqual([100, 102]);
    expect(r.find((t) => t.id === 102)!.executionName).toBe("S1");
  });
  test("执行查询失败跳过不崩", async () => {
    use((url) => {
      if (url.includes("/projects/5/executions")) return { status: 500, body: {} };
      throw new Error("nope");
    });
    const r = await cli().myTasks([5], null);
    expect(r).toEqual([]);
  });
});

describe("executions", () => {
  test("只留 status=doing", async () => {
    use((url) => {
      if (url.includes("/projects/5/executions"))
        return { status: 200, body: { executions: [
          { id: 1, status: "doing", name: "E1", end: "2026-12-31" },
          { id: 2, status: "closed", name: "E2" },
        ] } };
      throw new Error("nope");
    });
    const r = await cli().executions([5]);
    expect(r).toEqual([{ id: 1, name: "E1", project: 5, end: "2026-12-31" }]);
  });
});

describe("createTask", () => {
  test("assignedTo 数组失败 → 回退字符串", async () => {
    let n = 0;
    use((_u, init) => {
      n++;
      if (n === 1) {
        expect(init.body as string).toContain('"assignedTo":["me"]');
        return { status: 500, body: {} };
      }
      expect(init.body as string).toContain('"assignedTo":"me"');
      return { status: 200, body: { id: 200, name: "New" } };
    });
    const r = await cli().createTask(20, "New", 5);
    expect(r.created).toBe(true);
    expect(r.task.id).toBe(200);
  });
});

describe("submitEffort", () => {
  test("left 计算 roundPy(digits=1) + dryRun 不发 estimate POST", async () => {
    use((url) => {
      if (url.includes("/tasks/100") && !url.includes("estimate"))
        return { status: 200, body: { name: "T1", left: 3 } };
      throw new Error("dryRun 不该 POST estimate: " + url);
    });
    const r = await cli().submitEffort(100, "2026-08-06", 1.5, "w", null, true);
    expect(r.dryRun).toBe(true);
    expect(r.payload.left).toEqual([1.5]); // roundPy(3-1.5,1)=roundPy(1.5,1)=1.5
    expect(r.payload.consumed).toEqual([1.5]);
  });
  test("left 下限 0", async () => {
    use((url) => {
      if (url.includes("/tasks/100") && !url.includes("estimate"))
        return { status: 200, body: { name: "T1", left: 1 } };
      throw new Error("nope");
    });
    const r = await cli().submitEffort(100, "2026-08-06", 5, "w", null, true); // 1-5=-4 → max(.,0)=0
    expect(r.payload.left).toEqual([0]);
  });
  test("显式 left 不计算", async () => {
    use((url) => {
      if (url.includes("/tasks/100") && !url.includes("estimate"))
        return { status: 200, body: { name: "T1", left: 99 } };
      throw new Error("nope");
    });
    const r = await cli().submitEffort(100, "2026-08-06", 1, "w", 7, true);
    expect(r.payload.left).toEqual([7]);
  });
  test("非 dryRun 新 payload 失败 → legacy 回退", async () => {
    let n = 0;
    use((url, init) => {
      if (url.includes("/tasks/100") && !url.includes("estimate"))
        return { status: 200, body: { name: "T1", left: 3 } };
      if (url.includes("/estimate") && init.method === "POST") {
        n++;
        if (n === 1) return { status: 500, body: {} };
        expect(init.body as string).toContain("objectType"); // legacy 字段
        return { status: 200, body: { consumed: 1.5, left: 1.5 } };
      }
      throw new Error("nope");
    });
    const r = await cli().submitEffort(100, "2026-08-06", 1.5, "w", null, false);
    expect(r.submitted).toBe(true);
    expect(r.consumed).toBe(1.5);
  });
});
