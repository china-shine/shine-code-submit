import { describe, test, expect, spyOn, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  roundPy, pad2, esc, num, countLines, extractText, encodeProject, summaryPathFor,
  hoursFromMinutes, fmtHours, isObj, localDateISO, localHHMM, minutesSinceISO,
  todayISO, nowISOSeconds, loadJSON, writeJSON, writeText, requireStr, requireInt,
  epochForDate, LOOKBACK_MAX_DAYS,
  COMMIT_COOLDOWN_MINUTES, IDLE_CAP_MS,
} from "../lib/shared";

describe("roundPy (banker's rounding)", () => {
  test("tie → 偶数", () => {
    expect(roundPy(2.5)).toBe(2);
    expect(roundPy(3.5)).toBe(4);
    expect(roundPy(0.5)).toBe(0);
    expect(roundPy(1.5)).toBe(2);
    expect(roundPy(4.5)).toBe(4);
  });
  test("非 tie 四舍五入", () => {
    expect(roundPy(2.4)).toBe(2);
    expect(roundPy(2.6)).toBe(3);
    expect(roundPy(2.5000001)).toBe(3);
  });
  test("负数 tie → 偶数(符号保留)", () => {
    expect(roundPy(-2.5)).toBe(-2);
    expect(roundPy(-3.5)).toBe(-4);
    expect(roundPy(-2.4)).toBe(-2);
  });
  test("digits 指定小数位", () => {
    expect(roundPy(123.456, 1)).toBe(123.5);
    expect(roundPy(123.456, 2)).toBe(123.46);
    expect(roundPy(2, 0)).toBe(2);
  });
  test("零与整数", () => {
    expect(roundPy(0)).toBe(0);
    expect(roundPy(10)).toBe(10);
  });
});

describe("hoursFromMinutes (0.5 量子 + banker)", () => {
  test("标准刻度", () => {
    expect(hoursFromMinutes(60)).toBe(1);
    expect(hoursFromMinutes(30)).toBe(0.5);
    expect(hoursFromMinutes(90)).toBe(1.5);
    expect(hoursFromMinutes(120)).toBe(2);
  });
  test("tie 折向偶数", () => {
    expect(hoursFromMinutes(45)).toBe(1); // 1.5→2/2=1
    expect(hoursFromMinutes(75)).toBe(1); // 2.5→2/2=1
  });
  test("下限 0.5", () => {
    expect(hoursFromMinutes(0)).toBe(0.5);
    expect(hoursFromMinutes(15)).toBe(0.5); // 0.5→0/2=0→max 0.5
    expect(hoursFromMinutes(-60)).toBe(0.5);
  });
});

describe("pad2", () => {
  test("0-59 补零", () => {
    expect(pad2(0)).toBe("00");
    expect(pad2(5)).toBe("05");
    expect(pad2(9)).toBe("09");
    expect(pad2(10)).toBe("10");
    expect(pad2(59)).toBe("59");
  });
});

describe("esc (HTML 转义)", () => {
  test("特殊字符", () => {
    expect(esc("a&b")).toBe("a&amp;b");
    expect(esc("<>")).toBe("&lt;&gt;");
    expect(esc('"')).toBe("&quot;");
    expect(esc("'")).toBe("&#39;");
    expect(esc("&<>\"'")).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
  test("null/undefined → 空串", () => {
    expect(esc(null)).toBe("");
    expect(esc(undefined)).toBe("");
  });
  test("普通文本不变(含中文)", () => {
    expect(esc("hello 中文 123")).toBe("hello 中文 123");
  });
});

describe("num (安全数字)", () => {
  test("数字/数字串", () => {
    expect(num(5)).toBe(5);
    expect(num("5")).toBe(5);
    expect(num("3.5")).toBe(3.5);
  });
  test("非法 → 0", () => {
    expect(num("abc")).toBe(0);
    expect(num(null)).toBe(0);
    expect(num(undefined)).toBe(0);
    expect(num(Infinity)).toBe(0);
    expect(num(NaN)).toBe(0);
  });
});

describe("countLines", () => {
  test("字符串行数", () => {
    expect(countLines("a")).toBe(1);
    expect(countLines("a\nb\nc")).toBe(3);
    expect(countLines("a\n")).toBe(2);
  });
  test("空/非串 → 0", () => {
    expect(countLines("")).toBe(0);
    expect(countLines(null)).toBe(0);
    expect(countLines(123)).toBe(0);
  });
});

describe("extractText", () => {
  test("纯字符串", () => {
    expect(extractText("hello")).toBe("hello");
  });
  test("text block 数组(\\n 连接)", () => {
    expect(extractText([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
  });
  test("过滤非 text block", () => {
    expect(extractText([{ type: "tool_use" }, { type: "text", text: "x" }, { type: "image" }])).toBe("x");
  });
  test("空/无 text → 空", () => {
    expect(extractText([])).toBe("");
    expect(extractText([{ type: "tool_use" }])).toBe("");
    expect(extractText([{ type: "text" }])).toBe(""); // 无 text 字段
    expect(extractText(null)).toBe("");
    expect(extractText(123)).toBe("");
  });
});

describe("encodeProject", () => {
  test("非字母数字 → -", () => {
    expect(encodeProject("ab cd")).toBe("ab-cd");
    expect(encodeProject("a/b")).toBe("a-b");
    expect(encodeProject("a.b-c")).toBe("a-b-c");
  });
  test("中文 → -", () => {
    expect(encodeProject("中文")).toBe("--");
  });
  test("空串/纯字母数字", () => {
    expect(encodeProject("")).toBe("");
    expect(encodeProject("abc123")).toBe("abc123");
  });
});

describe("summaryPathFor", () => {
  test("含项目目录与 summary 文件名", () => {
    const p = summaryPathFor("2026-08-06");
    expect(p.endsWith("summary-2026-08-06.json")).toBe(true);
    expect(p.includes("projects")).toBe(true);
  });
});

describe("fmtHours", () => {
  test("整数→.0 非整数→原样", () => {
    expect(fmtHours(2)).toBe("2.0");
    expect(fmtHours(0)).toBe("0.0");
    expect(fmtHours(2.5)).toBe("2.5");
    expect(fmtHours(1.5)).toBe("1.5");
  });
});

describe("isObj", () => {
  test("对象/数组 true", () => {
    expect(isObj({})).toBe(true);
    expect(isObj([])).toBe(true);
  });
  test("null/原始 false", () => {
    expect(isObj(null)).toBe(false);
    expect(isObj(undefined)).toBe(false);
    expect(isObj("a")).toBe(false);
    expect(isObj(5)).toBe(false);
  });
});

describe("日期族", () => {
  test("localDateISO(本地非UTC)", () => {
    expect(localDateISO("2026-08-06T12:00:00")).toBe("2026-08-06");
    expect(localDateISO("2026-01-09")).toBe("2026-01-09");
  });
  test("localDateISO 兼容 epoch ms(daemon lastActive;多天补报会话归属日)", () => {
    expect(localDateISO(new Date("2026-08-06T10:00:00").getTime())).toBe("2026-08-06");
    expect(localDateISO(new Date("2026-08-05T23:59:00").getTime())).toBe("2026-08-05");
  });
  test("epochForDate(todayISO 反操作,本地 0 点)", () => {
    const iso = "2026-08-16";
    const t = epochForDate(iso);
    const d = new Date(t);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(7);
    expect(d.getDate()).toBe(16);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(localDateISO(t)).toBe(iso);
    expect(LOOKBACK_MAX_DAYS).toBe(14); // 回看上限(改动时同步文档 08/10)
  });
  test("localHHMM", () => {
    expect(localHHMM("2026-08-06T09:05:00")).toBe("09:05");
  });
  test("minutesSinceISO 过去为正(本地 ISO)", () => {
    const d = new Date(Date.now() - 5 * 60000);
    const p = (n: number) => String(n).padStart(2, "0");
    const iso = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    const m = minutesSinceISO(iso);
    expect(m).toBeGreaterThan(4.9);
    expect(m).toBeLessThan(5.5);
  });
  test("todayISO / nowISOSeconds 格式", () => {
    expect(todayISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(nowISOSeconds()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });
});

describe("FS: loadJSON/writeJSON/writeText", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "zen-shared-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("loadJSON 不存在→default", () => {
    expect(loadJSON(path.join(dir, "nope.json"), { a: 1 })).toEqual({ a: 1 });
    expect(loadJSON(path.join(dir, "nope.json"), null)).toBe(null);
  });
  test("writeJSON+loadJSON 往返 + 自动建父目录", () => {
    const f = path.join(dir, "sub", "deep", "x.json");
    writeJSON(f, { b: 2, arr: [1, 2] });
    expect(loadJSON(f, null)).toEqual({ b: 2, arr: [1, 2] });
    expect(readFileSync(f, "utf8").endsWith("\n")).toBe(true);
  });
  test("writeText 写纯文本 + 自动建父目录", () => {
    const f = path.join(dir, "nested", "y.txt");
    writeText(f, "hello");
    expect(readFileSync(f, "utf8")).toBe("hello");
  });
});

describe("requireStr/requireInt", () => {
  test("正常取值", () => {
    expect(requireStr({ cmd: "x", k: "v" }, "k")).toBe("v");
    expect(requireInt({ cmd: "x", k: "5" }, "k")).toBe(5);
  });
  test("缺失→die(console.log + process.exit 1)", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const exit = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT_${code ?? 0}`);
    }) as never);
    expect(() => requireStr({ cmd: "x" }, "k")).toThrow("EXIT_1");
    expect(() => requireInt({ cmd: "x" }, "missing")).toThrow("EXIT_1");
    expect(log.mock.calls[0][0]).toContain("缺少必填参数");
    log.mockRestore();
    exit.mockRestore();
  });
});

describe("常量", () => {
  test("冷却与空闲阈值", () => {
    expect(COMMIT_COOLDOWN_MINUTES).toBe(30);
    expect(IDLE_CAP_MS).toBe(10 * 60 * 1000);
  });
});
