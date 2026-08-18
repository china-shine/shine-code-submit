import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { parseTranscriptEvents, toZenSession, extractTranscriptSignals } from "../lib/transcript";
import { encodeProject } from "../lib/shared";

// Claude transcript event 构造 helper
const user = (text: string) => ({ message: { role: "user", content: text }, timestamp: "2026-08-06T09:00:00" });
const assistText = (text: string) => ({ message: { role: "assistant", content: [{ type: "text", text }] } });
const toolUse = (name: string, input: any) => ({ message: { role: "assistant", content: [{ type: "tool_use", name, input }] } });
const raw = (...evs: any[]) => evs.map((e) => JSON.stringify(e)).join("\n");

describe("parseTranscriptEvents", () => {
  test("空串 → null", () => {
    expect(parseTranscriptEvents("")).toBeNull();
  });
  test("纯 user prompt", () => {
    const r = parseTranscriptEvents(raw(user("hello world")));
    expect(r).not.toBeNull();
    expect(r!.prompts).toEqual(["hello world"]);
    expect(r!.assistantTexts).toEqual([]);
    expect(r!.toolUseCounts).toEqual({});
    expect(r!.files).toEqual([]);
    expect(r!.added).toBe(0);
    expect(r!.removed).toBe(0);
  });
  test("user prompt 过滤: < 开头 / 太短(≤1) / 太长(>300)", () => {
    const r = parseTranscriptEvents(raw(
      user("<system-reminder>"),
      user("a"),
      user("x".repeat(301)),
      user("ok valid prompt"),
    ));
    expect(r!.prompts).toEqual(["ok valid prompt"]);
  });
  test("assistant text 收集", () => {
    const r = parseTranscriptEvents(raw(assistText("hi"), assistText("bye")));
    expect(r!.assistantTexts).toEqual(["hi", "bye"]);
  });
  test("Edit: added/removed/files/计数", () => {
    const r = parseTranscriptEvents(raw(toolUse("Edit", { file_path: "/a.ts", new_string: "x\ny", old_string: "z" })));
    expect(r!.toolUseCounts).toEqual({ Edit: 1 });
    expect(r!.files).toEqual(["/a.ts"]);
    expect(r!.added).toBe(2);
    expect(r!.removed).toBe(1);
  });
  test("Write: added = content 行数", () => {
    const r = parseTranscriptEvents(raw(toolUse("Write", { file_path: "/b.ts", content: "a\nb\nc" })));
    expect(r!.added).toBe(3);
    expect(r!.removed).toBe(0);
    expect(r!.files).toEqual(["/b.ts"]);
    expect(r!.toolUseCounts.Write).toBe(1);
  });
  test("MultiEdit: 多 edit 累加", () => {
    const r = parseTranscriptEvents(raw(toolUse("MultiEdit", {
      file_path: "/c.ts",
      edits: [
        { new_string: "p", old_string: "q" },
        { new_string: "r\ns", old_string: "t\nu" },
      ],
    })));
    expect(r!.added).toBe(3);
    expect(r!.removed).toBe(3);
  });
  test("混合 user + assistant + tool_use", () => {
    const r = parseTranscriptEvents(raw(
      user("fix bug"),
      assistText("done"),
      toolUse("Edit", { file_path: "/x", new_string: "a", old_string: "b" }),
    ));
    expect(r!.prompts).toEqual(["fix bug"]);
    expect(r!.assistantTexts).toEqual(["done"]);
    expect(r!.toolUseCounts.Edit).toBe(1);
    expect(r!.added).toBe(1);
  });
  test("非 Claude(无 role/system) → null", () => {
    expect(parseTranscriptEvents(raw({ foo: "bar" }))).toBeNull();
    expect(parseTranscriptEvents(raw({ message: { role: "system", content: "x" } }))).toBeNull();
  });
  test("无效 JSON 行跳过", () => {
    const r = parseTranscriptEvents("not json line\n" + raw(user("ok")));
    expect(r!.prompts).toEqual(["ok"]);
  });
  test("tool_use input 缺字段不崩", () => {
    const r = parseTranscriptEvents(raw(toolUse("Edit", {})));
    expect(r!.toolUseCounts.Edit).toBe(1);
    expect(r!.files).toEqual([]);
    expect(r!.added).toBe(0);
  });
});

describe("toZenSession (字段映射)", () => {
  test("完整字段映射", () => {
    const lastActive = new Date("2026-08-06T10:00:00").getTime();
    const z = toZenSession({
      sessionId: "s1", cwd: "/repo", activeMs: 30 * 60000, lastActive,
      tokenTotal: { input: 100, cacheCreation: 50, cacheRead: 30, output: 200 },
      linesTotal: { added: 10, deleted: 5, modified: 3 },
      title: "做某事",
    }, "main");
    expect(z.id).toBe("s1");
    expect(z.cwd).toBe("/repo");
    expect(z.repo).toBe("repo");
    expect(z.branch).toBe("main");
    expect(z.activeMinutes).toBe(30);
    expect(z.end).toBe("10:00");
    expect(z.start).toBe("09:30");
    expect(z.tokens).toEqual({ input: 180, output: 200 }); // 100+50+30
    expect(z.linesAdded).toBe(13); // 10+3
    expect(z.linesRemoved).toBe(8); // 5+3
    expect(z.filesChanged).toBe(0);
    expect(z.summary).toBe("做某事");
    expect(z.date).toBe("2026-08-06"); // 会话归属日(lastActive 推,多天补报时 item.date/禅道 date 用)
  });
  test("branch null 透传", () => {
    const z = toZenSession({ sessionId: "s", activeMs: 0, lastActive: 0 }, null);
    expect(z.branch).toBeNull();
  });
  test("title 空 → (无文本提示)", () => {
    const z = toZenSession({ sessionId: "s", activeMs: 0, lastActive: 0, title: "" }, null);
    expect(z.summary).toBe("(无文本提示)");
  });
});

describe("extractTranscriptSignals", () => {
  const cwd = "zentao-test-iso-dir";
  const sid = "test-session-fixed";
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = path.join(homedir(), ".claude", "projects", encodeProject(cwd));
    file = path.join(dir, sid + ".jsonl");
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("文件不存在 → null", () => {
    rmSync(file, { force: true });
    expect(extractTranscriptSignals("nonexistent-session", cwd)).toBeNull();
  });
  test("正常提取: prompts 前5 / assistantTexts 最近6 截500 / files 相对 cwd / 行数", () => {
    writeFileSync(file, raw(
      ...Array.from({ length: 7 }, (_, i) => user(`prompt ${i}`)),
      assistText("short"),
      assistText("x".repeat(600)),
      toolUse("Edit", { file_path: path.join(cwd, "sub", "a.ts"), new_string: "a\nb", old_string: "c" }),
    ));
    const r = extractTranscriptSignals(sid, cwd);
    expect(r).not.toBeNull();
    expect(r!.prompts.length).toBe(5);
    expect(r!.prompts[0]).toBe("prompt 0");
    expect(r!.recentAssistantTexts.length).toBe(2);
    expect(r!.recentAssistantTexts[1].length).toBe(500); // 600 截断
    expect(r!.toolUseCounts.Edit).toBe(1);
    expect(r!.filesChanged.length).toBe(1);
    expect(r!.filesChanged[0]).toContain("a.ts"); // 相对 cwd(跨平台分隔符)
    expect(r!.linesAdded).toBe(2);
    expect(r!.linesRemoved).toBe(1);
  });
});
