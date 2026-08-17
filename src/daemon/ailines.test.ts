// ailines 提取与文件存储单测(2026-08-17 换源终局:行数+AI 行集合来自 transcript)。
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAiLinesEvents, emptyAiLines, serializeAiLines, parseAiLinesBlob, isEmptyAiLines } from "./ailines";
import { AiLinesStore, readSessionAiLines, readProjectAiLines } from "./ailines-store";
import { countPatchLines } from "./lines";

const line = (o: Record<string, unknown>) => JSON.stringify(o);
const T0 = "2026-08-17T10:00:00.000Z";
const base = mkdtempSync(join(tmpdir(), "ailines-test-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const editUse = (id: string, oldS: string, newS: string, ts = T0) =>
  line({ type: "assistant", timestamp: ts, cwd: "C:\\proj", message: { role: "assistant", content: [
    { type: "tool_use", id, name: "Edit", input: { file_path: "C:\\proj\\a.ts", old_string: oldS, new_string: newS } },
  ] } });
const result = (id: string, isErr = false, ts = T0) =>
  line({ type: "user", timestamp: ts, message: { role: "user", content: [
    { type: "tool_result", tool_use_id: id, is_error: isErr, content: "ok" },
  ] } });

describe("parseAiLinesEvents(提取器)", () => {
  test("成功 Edit:行数 min 配对口径 + 行内容入集合", () => {
    const st = parseAiLinesEvents(editUse("e1", "旧A\n旧B\n旧C", "新A\n新B\n新C\n新D") + "\n" + result("e1"), emptyAiLines());
    // plus=4, minus=3 → modified=3, added=1, deleted=0(与 countPatchLines 同配对法)
    expect(st.lines).toEqual({ added: 1, deleted: 0, modified: 3 });
    expect(st.aiAdded["C:\\proj\\a.ts"]).toEqual(["新A", "新B", "新C", "新D"]);
    expect(st.aiDeleted["C:\\proj\\a.ts"]).toEqual(["旧A", "旧B", "旧C"]);
    expect(st.cwd).toBe("C:\\proj");
  });

  test("失败 Edit(is_error):pending 丢弃,行数与集合都不计", () => {
    const st = parseAiLinesEvents(editUse("e2", "旧", "新X\n新Y") + "\n" + result("e2", true), emptyAiLines());
    expect(st.lines).toEqual({ added: 0, deleted: 0, modified: 0 });
    expect(st.aiAdded).toEqual({});
  });

  test("未闭环 Edit 停在 pending;跨 blob(跨 tick)可继续判定", () => {
    const st1 = parseAiLinesEvents(editUse("e3", "旧", "新"), emptyAiLines());
    expect(st1.pending.length).toBe(1);
    expect(st1.lines.added).toBe(0); // 未判定不计
    // 序列化落盘 → 下个 tick 从 blob 恢复,tool_result 到达后落地
    const st2 = parseAiLinesBlob(serializeAiLines(st1))!;
    parseAiLinesEvents(result("e3"), st2);
    expect(st2.pending.length).toBe(0);
    expect(st2.lines.modified).toBe(1);
  });

  test("重放同 id 的 tool_use 不翻倍", () => {
    const raw = editUse("e4", "旧", "新") + "\n" + result("e4") + "\n" + editUse("e4", "旧", "新") + "\n" + result("e4");
    const st = parseAiLinesEvents(raw, emptyAiLines());
    expect(st.lines.modified).toBe(1);
  });

  test("Write 新建:content 全计 added,行内容入集合(空行/纯括号被滤)", () => {
    const raw = line({ type: "assistant", timestamp: T0, message: { role: "assistant", content: [
      { type: "tool_use", id: "w1", name: "Write", input: { file_path: "C:\\proj\\b.ts", content: "const x = 1;\n}\n};\n" } },
    ] } }) + "\n" + result("w1");
    const st = parseAiLinesEvents(raw, emptyAiLines());
    expect(st.lines).toEqual({ added: 4, deleted: 0, modified: 0 }); // split 含尾空段=4
    expect(st.aiAdded["C:\\proj\\b.ts"]).toEqual(["const x = 1;"]); // }/}; 与空行是平凡行
  });

  test("MultiEdit:逐段累计", () => {
    const raw = line({ type: "assistant", timestamp: T0, message: { role: "assistant", content: [
      { type: "tool_use", id: "m1", name: "MultiEdit", input: { file_path: "C:\\proj\\c.ts", edits: [
        { old_string: "a", new_string: "b" }, { old_string: "x", new_string: "y\nz" },
      ] } },
    ] } }) + "\n" + result("m1");
    const st = parseAiLinesEvents(raw, emptyAiLines());
    // 段1: p1/m1→mod1;段2: p2/m1→mod1+add1 → 合计 added1 modified2
    expect(st.lines).toEqual({ added: 1, deleted: 0, modified: 2 });
  });

  test("口径等价:同内容 patch 行 vs 内容行数,added/deleted/modified 一致", () => {
    const oldS = "line1\nline2", newS = "line1\nline2x\nline3";
    const patch = [{ lines: ["-" + oldS.split("\n")[1], "+" + newS.split("\n")[1], "+" + newS.split("\n")[2]] }];
    const fromPatch = countPatchLines(patch as never); // 原 events 口径
    const st = parseAiLinesEvents(editUse("eq", oldS, newS) + "\n" + result("eq"), emptyAiLines());
    expect(st.lines).toEqual(fromPatch);
  });
});

describe("AiLinesStore + 读取(文件存储)", () => {
  const parent = join(base, "sess1.jsonl");
  const subagentDir = join(base, "sess1", "subagents");
  const subagent = join(subagentDir, "sub1.jsonl");
  const projectId = "C--proj";
  const cwd = "C:\\proj";

  test("回填重建含子代理文件;readSession/readProject 全链路", () => {
    writeFileSync(parent, editUse("p1", "旧P", "新P") + "\n" + result("p1") + "\n" +
      line({ type: "assistant", timestamp: T0, message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }), "utf8");
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(subagent, editUse("s1", "旧S", "新S") + "\n" + result("s1"), "utf8");

    const store = new AiLinesStore(base);
    store.update({ parentPath: parent, sessionId: "sess1", projectId }, "", false, true); // 无旧文件 → 整session重建
    const st = readSessionAiLines(projectId, "sess1", base)!;
    expect(st.lines.modified).toBe(2); // 父 + 子代理各 1
    expect(st.aiAdded["C:\\proj\\a.ts"]).toEqual(["新P", "新S"]); // 同文件去重合并

    const proj = readProjectAiLines(cwd, base);
    expect(proj.added.get("a.ts")).toEqual(new Set(["新P", "新S"])); // normRelPath 相对化
  });

  test("增量:已有状态 + 新行合并,不翻倍", () => {
    const store = new AiLinesStore(base);
    store.update({ parentPath: parent, sessionId: "sess1", projectId }, "", false, true); // 先建
    const tail = editUse("p2", "旧Q", "新Q", "2026-08-17T11:00:00.000Z") + "\n" + result("p2", false, "2026-08-17T11:00:01.000Z");
    writeFileSync(parent, readFileSync(parent, "utf8") + "\n" + tail, "utf8");
    store.update({ parentPath: parent, sessionId: "sess1", projectId }, tail, false, true);
    const st = readSessionAiLines(projectId, "sess1", base)!;
    expect(st.lines.modified).toBe(3);
    expect(st.aiAdded["C:\\proj\\a.ts"]).toEqual(["新P", "新S", "新Q"]);
  });

  test("落后自愈:状态文件 mtime 落后于父 transcript → 无新行也重建", () => {
    const store = new AiLinesStore(base);
    const tail2 = editUse("p3", "旧R", "新R", "2026-08-17T12:00:00.000Z") + "\n" + result("p3", false, "2026-08-17T12:00:01.000Z");
    writeFileSync(parent, readFileSync(parent, "utf8") + "\n" + tail2, "utf8");
    const stateFile = join(base, projectId, "2026-08-17", "sess1.json");
    const past = new Date(Date.now() - 60_000);
    utimesSync(stateFile, past, past); // 模拟落后
    expect(store.needsConsume({ sessionId: "sess1", projectId, transcriptMtimeMs: Date.now() })).toBe(true);
    store.update({ parentPath: parent, sessionId: "sess1", projectId }, "", false, true);
    expect(readSessionAiLines(projectId, "sess1", base)!.lines.modified).toBe(4); // p3 补回
  });

  test("空 transcript 不落空文件;损坏 blob 触发重建", () => {
    const empty = join(base, "empty.jsonl");
    writeFileSync(empty, "", "utf8");
    const store = new AiLinesStore(base);
    store.update({ parentPath: empty, sessionId: "ghost", projectId }, "", false, true);
    expect(readSessionAiLines(projectId, "ghost", base)).toBeNull();
    // 损坏:手写坏 JSON 到正确路径 → update 增量分支发现 parse 失败 → 重建
    const badDir = join(base, projectId, "2026-08-17");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "sess1.json"), "{oops", "utf8");
    store.update({ parentPath: parent, sessionId: "sess1", projectId }, editUse("p4", "旧T", "新T") + "\n" + result("p4"), false, true);
    expect(readSessionAiLines(projectId, "sess1", base)).not.toBeNull();
  });
});
