import { describe, test, expect } from "bun:test";
import { renumberWorks, renderReportHtml, renderReportText, reportFilename, lastWeekRange } from "../lib/report";

describe("renumberWorks", () => {
  test("多条 work 跨条顺延编号", () => {
    expect(renumberWorks(["1. a\n2. b", "3. c"])).toBe("1. a\n2. b\n3. c");
  });
  test("无原编号也加编号", () => {
    expect(renumberWorks(["a", "b"])).toBe("1. a\n2. b");
  });
  test("空数组 → 空串", () => {
    expect(renumberWorks([])).toBe("");
  });
  test("空行跳过", () => {
    expect(renumberWorks(["1. a\n\n2. b"])).toBe("1. a\n2. b");
  });
  test("去原编号(多位数)", () => {
    expect(renumberWorks(["10. x"])).toBe("1. x");
  });
  test("trim 空白", () => {
    expect(renumberWorks(["  1. 带空格  "])).toBe("1. 带空格");
  });
  test("手填逗号序号: 不双层编号(1,xxx / 2，xxx)", () => {
    expect(renumberWorks(["1,由于服务器卡", "2，本地调通"])).toBe("1. 由于服务器卡\n2. 本地调通");
  });
  test("手填顿号序号", () => {
    expect(renumberWorks(["1、第一项", "2、第二项"])).toBe("1. 第一项\n2. 第二项");
  });
  test("括号序号(全/半角)", () => {
    expect(renumberWorks(["（1）全角", "(2) 半角"])).toBe("1. 全角\n2. 半角");
  });
  test("冒号序号(全/半角)", () => {
    expect(renumberWorks(["1: 半角冒号", "2：全角冒号"])).toBe("1. 半角冒号\n2. 全角冒号");
  });
  test("手填带序号 + 无序号混合(复现禅道双层 bug)", () => {
    expect(renumberWorks(["1,服务器卡\n2，本地调通", "配置gitignore\n整理Dify"])).toBe(
      "1. 服务器卡\n2. 本地调通\n3. 配置gitignore\n4. 整理Dify",
    );
  });
  test("版本号不误剥(3.14 / 2026.08)", () => {
    expect(renumberWorks(["3.14 升级版本"])).toBe("1. 3.14 升级版本");
    expect(renumberWorks(["2026.08 配置"])).toBe("1. 2026.08 配置");
  });
});

const mkDaily = (over: Record<string, unknown> = {}): any => ({
  from: "2026-08-06", to: "2026-08-06", title: "日报 2026-08-06", realname: "张三",
  dates: ["2026-08-06"],
  byDate: { "2026-08-06": { "77563": { hours: 1.5, works: ["1. 拆分\n2. 清理"] } } },
  infoMap: new Map([[77563, { taskName: "AI提效", projectName: "日常工作/AI智能体" }]]),
  zentaoUrl: "https://zentao",
  ...over,
});

describe("renderReportHtml", () => {
  test("日报: 类型/姓名/任务/工时/合计/链接", () => {
    const html = renderReportHtml(mkDaily());
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("日报");
    expect(html).toContain("张三");
    expect(html).toContain("AI提效");
    expect(html).toContain("#77563");
    expect(html).toContain("1.5h");
    expect(html).toContain("合计");
    expect(html).toContain("taskID=77563");
  });
  test("周报: 同任务跨天 rowspan + 本周合计", () => {
    const d: any = {
      from: "2026-08-04", to: "2026-08-06", title: "周报", realname: "李四",
      dates: ["2026-08-05", "2026-08-06"],
      byDate: {
        "2026-08-05": { "100": { hours: 2, works: ["任务A"] } },
        "2026-08-06": { "100": { hours: 1, works: ["任务A续"] }, "200": { hours: 0.5, works: ["任务B"] } },
      },
      infoMap: new Map([[100, { taskName: "T1", projectName: "P1" }], [200, { taskName: "T2", projectName: "P2" }]]),
      zentaoUrl: "https://zentao",
    };
    const html = renderReportHtml(d);
    expect(html).toContain("周报");
    expect(html).toContain('rowspan="2"'); // 任务 100 跨两天
    expect(html).toContain("本周合计");
    expect(html).toContain("3.5h"); // 2+1+0.5
  });
  test("空数据: 提示 + 总工时 —", () => {
    const d: any = { from: "2026-08-06", to: "2026-08-06", title: "日报 2026-08-06", realname: "张三", dates: [], byDate: {}, infoMap: new Map(), zentaoUrl: "u" };
    const html = renderReportHtml(d);
    expect(html).toContain("没有禅道提交记录");
    expect(html).toContain("—"); // statNum
  });
  test("HTML 转义 taskName/projectName", () => {
    const d: any = {
      from: "2026-08-06", to: "2026-08-06", title: "日报 2026-08-06", realname: "x",
      dates: ["2026-08-06"],
      byDate: { "2026-08-06": { "1": { hours: 1, works: ["a"] } } },
      infoMap: new Map([[1, { taskName: "<script>", projectName: "A&B" }]]),
      zentaoUrl: "u",
    };
    const html = renderReportHtml(d);
    expect(html).toContain("&lt;script&gt;"); // taskName 被转义
    expect(html).not.toContain("<script>"); // 无原始危险标签
    // projectName 仅用于 projects 计数,不渲染文本(此处不验证)
  });
  test("aiHours>0: hero 含 'AI 代报' chip", () => {
    const html = renderReportHtml(mkDaily({ aiHours: 1.5 }));
    expect(html).toContain("AI 代报");
    expect(html).toContain("1.5h</b>AI 代报");
  });
  test("aiHours 缺省/0: 不显示 AI 代报", () => {
    expect(renderReportHtml(mkDaily())).not.toContain("AI 代报");
    expect(renderReportText(mkDaily())).not.toContain("其中 AI 代报");
  });
});

describe("renderReportText", () => {
  test("日报文本摘要", () => {
    const txt = renderReportText(mkDaily());
    expect(txt).toContain("日报 2026-08-06 · 张三");
    expect(txt).toContain("日常工作/AI智能体 / AI提效 #77563");
    expect(txt).toContain("1.5h");
    expect(txt).toContain("合计 1.5h · 1 个任务");
  });
  test("周报文本含 [月-日] 前缀 + 本周合计", () => {
    const d: any = {
      from: "2026-08-04", to: "2026-08-06", title: "周报", realname: "x",
      dates: ["2026-08-06"],
      byDate: { "2026-08-06": { "1": { hours: 2, works: ["a"] } } },
      infoMap: new Map([[1, { taskName: "T1", projectName: "P1" }]]),
      zentaoUrl: "u",
    };
    const txt = renderReportText(d);
    expect(txt).toContain("[08-06");
    expect(txt).toContain("本周合计 2h");
  });
  test("空数据", () => {
    const d: any = { from: "2026-08-06", to: "2026-08-06", title: "日报 2026-08-06", realname: "张三", dates: [], byDate: {}, infoMap: new Map(), zentaoUrl: "u" };
    expect(renderReportText(d)).toContain("没有禅道提交记录");
  });
  test("aiHours>0: 合计行含 '其中 AI 代报'", () => {
    expect(renderReportText(mkDaily({ aiHours: 1.2 }))).toContain("其中 AI 代报 1.2h");
  });
});

describe("reportFilename", () => {
  test("日报带 realname", () => {
    expect(reportFilename("2026-08-06", "2026-08-06", "任桂峰")).toBe("日报-2026-08-06-任桂峰.html");
  });
  test("周报带 realname", () => {
    expect(reportFilename("2026-08-03", "2026-08-09", "任桂峰")).toBe("周报-2026-08-03~2026-08-09-任桂峰.html");
  });
  test("realname 空 → unknown", () => {
    expect(reportFilename("2026-08-06", "2026-08-06", "")).toBe("日报-2026-08-06-unknown.html");
  });
  test("去路径非法字符", () => {
    expect(reportFilename("2026-08-06", "2026-08-06", "a/b:c")).toBe("日报-2026-08-06-abc.html");
  });
});

describe("lastWeekRange", () => {
  test("返回上周一~上周日(周一开头、周日结尾、间隔6天)", () => {
    const [from, to] = lastWeekRange();
    const f = new Date(from + "T00:00:00");
    const t = new Date(to + "T00:00:00");
    expect(f.getDay()).toBe(1); // 周一
    expect(t.getDay()).toBe(0); // 周日
    expect(Math.round((t.getTime() - f.getTime()) / 86400000)).toBe(6); // 跨 6 天
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
