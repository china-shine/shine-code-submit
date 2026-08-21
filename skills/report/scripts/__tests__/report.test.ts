import { describe, test, expect } from "bun:test";
import { renderReportHtml, renderReportText, reportFilename, lastWeekRange, reportTaskIds, cacheStaleVsSubmissions } from "../lib/report";
// renumberWorks 已删(9b4b559 起 work 排版移到 AI,该函数成死代码,连同其测试一并移除)。

const mkDaily = (over: Record<string, unknown> = {}): any => ({
  from: "2026-08-06", to: "2026-08-06", title: "日报 2026-08-06", realname: "张三",
  dates: ["2026-08-06"],
  byDate: { "2026-08-06": { "77563": { hours: 1.5, works: ["1. 拆分\n2. 清理"] } } },
  infoMap: new Map([[77563, { taskName: "AI提效", projectName: "日常工作/AI智能体" }]]),
  zentaoUrl: "https://zentao",
  markText: "",
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
    expect(html).toContain("<b>1</b>个任务"); // 顶部 chips 计数(曾回归恒显 0,见 taskCount 同步)
  });
  test("日报多天区间: 每天分区渲染,不丢天(修复静默只渲染首日)", () => {
    const d: any = {
      from: "2026-08-05", to: "2026-08-06", title: "日报 2026-08-05", realname: "张三", daily: true,
      dates: ["2026-08-05", "2026-08-06"],
      byDate: {
        "2026-08-05": { "77563": { hours: 1, works: ["第一天"] } },
        "2026-08-06": { "77563": { hours: 1.5, works: ["第二天"] } },
      },
      infoMap: new Map([[77563, { taskName: "AI提效", projectName: "日常工作/AI智能体" }]]),
      zentaoUrl: "https://zentao",
    };
    const html = renderReportHtml(d);
    // 两天都渲染(不再只出 08-05),每天带分区标题
    expect(html).toContain("08-05"); // day-head 分区标题
    expect(html).toContain("08-06");
    expect(html).toContain("第一天");
    expect(html).toContain("第二天");
    expect(html).toContain("区间合计");
    expect(html).toContain("2.5h"); // 1 + 1.5
    expect(html).toContain("<b>1</b>个任务"); // 顶部 chips:同任务跨两天去重为 1(曾回归恒显 0)
  });
  test("周报: 同任务跨天合并到一个折叠块 + 本周合计", () => {
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
    expect(html).toContain('<details class="task">'); // 按任务折叠(默认收起)
    expect(html).toContain("08-05");
    expect(html).toContain("08-06"); // 任务 100 跨两天合并到同一折叠块(两 day-row)
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
  test("work 含括号 AI 标识: HTML 行内显示标识在内容末尾", () => {
    const html = renderReportHtml(mkDaily({
      byDate: { "2026-08-06": { "77563": { hours: 1.5, works: ["调研claude-mem(本次内容由AI填报)"] } } },
    }));
    expect(html).toContain("调研claude-mem(本次内容由AI填报)"); // 标识行内保留在内容末尾
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
  test("日报多天区间文本: 逐日 [月-日] 头 + 不丢天", () => {
    const d: any = {
      from: "2026-08-05", to: "2026-08-06", title: "日报 2026-08-05", realname: "x", daily: true,
      dates: ["2026-08-05", "2026-08-06"],
      byDate: {
        "2026-08-05": { "1": { hours: 1, works: ["a"] } },
        "2026-08-06": { "1": { hours: 1.5, works: ["b"] } },
      },
      infoMap: new Map([[1, { taskName: "T1", projectName: "P1" }]]),
      zentaoUrl: "u",
    };
    const txt = renderReportText(d);
    expect(txt).toContain("[08-05");
    expect(txt).toContain("[08-06"); // 两天都有日期头
    expect(txt).toContain("a");
    expect(txt).toContain("b"); // 第二天内容不丢
    expect(txt).toContain("合计 2.5h · 1 个任务"); // 同一任务跨两天,唯一任务数去重为 1
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
  test("kind=weekly 强制周报(即便 from===to,复现周一 /weekly 误判)", () => {
    expect(reportFilename("2026-08-10", "2026-08-10", "任桂峰", "weekly")).toBe("周报-2026-08-10~2026-08-10-任桂峰.html");
  });
});

describe("reportTaskIds", () => {
  test("已完成任务(taskDetails)也进聚合集合——转 done 后工时不消失(#78363)", () => {
    const ids = reportTaskIds(
      { tasks: [{ id: 77563 }], taskDetails: { "78363": { name: "为门诊部门搭建dify环境", project: 6924 } } },
      "2026-08-17", "2026-08-17",
    );
    expect(ids.has(77563)).toBe(true); // 未完成(cache.tasks)
    expect(ids.has(78363)).toBe(true); // 当天转 done,已移出 cache.tasks、只剩 taskDetails
  });
  test("taskDetails 缺省不炸(老缓存无该字段)", () => {
    const ids = reportTaskIds({ tasks: [] }, "2026-08-17", "2026-08-17");
    expect(ids.size).toBeGreaterThanOrEqual(0);
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

describe("cacheStaleVsSubmissions", () => {
  test("非法日期直接短路返回 false——曾 `NaN-NaN-NaN` 循环恒真永久挂死(修复点)", () => {
    // 无缓存文件时立即返回 false;关键是不死循环(旧实现对自然语言日期挂死)
    expect(cacheStaleVsSubmissions("昨天", "昨天")).toBe(false);
    expect(cacheStaleVsSubmissions("abc", "def")).toBe(false);
    expect(cacheStaleVsSubmissions("", "")).toBe(false);
  });
  test("from>to 不进入循环返回 false", () => {
    expect(cacheStaleVsSubmissions("2026-08-10", "2026-08-01")).toBe(false);
  });
  test("无缓存/未配置 fetchedAt 返回 false", () => {
    expect(cacheStaleVsSubmissions("2026-08-05", "2026-08-06")).toBe(false);
  });
});
