import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractCommitSubject,
  isRealUserPrompt,
  parseSignalEvents,
  parseSignalsBlob,
  serializeSignals,
  emptySignals,
} from "./signals";
import { SignalsStore, readSignalsForApi } from "./signals-store";

const line = (o: Record<string, unknown>) => JSON.stringify(o);
const T0 = "2026-08-17T10:00:00.000Z";
const T1 = "2026-08-17T10:05:00.000Z";
const T2 = "2026-08-17T11:00:00.000Z";

describe("extractCommitSubject(git commit 提取)", () => {
  test("heredoc 形式取首行 subject", () => {
    const cmd = `cd /p && git add a.ts && git commit -m "$(cat <<'EOF'\nfeat(report): 新增信号提取\n\n正文细节\nEOF\n)"`;
    expect(extractCommitSubject(cmd)).toBe("feat(report): 新增信号提取");
  });
  test('-m "..." 取首行', () => {
    expect(extractCommitSubject(`git commit -m "fix: 修复超时"`)).toBe("fix: 修复超时");
  });
  test("非 commit / 提不出 message → null", () => {
    expect(extractCommitSubject("git status")).toBeNull();
    expect(extractCommitSubject("git commit --amend")).toBeNull(); // 无 -m
  });
});

describe("isRealUserPrompt(用户意图过滤)", () => {
  test("真实提问通过", () => {
    expect(isRealUserPrompt("改成拉取最近20天的数据吧")).toBe(true);
  });
  test("wrapper/Caveat/中断/超长粘贴过滤", () => {
    expect(isRealUserPrompt("<command-message>/report</command-message>")).toBe(false);
    expect(isRealUserPrompt("Caveat: The messages below were generated")).toBe(false);
    expect(isRealUserPrompt("[Request interrupted by user for tool use]")).toBe(false);
    expect(isRealUserPrompt("x".repeat(501))).toBe(false);
    expect(isRealUserPrompt("继续")).toBe(true); // 短但 >1 字
    expect(isRealUserPrompt("x")).toBe(false); // 单字符
  });
});

function fixtureSession(): string {
  return [
    line({ type: "user", timestamp: T0, cwd: "C:\\proj", message: { role: "user", content: "修复登录超时问题" } }),
    line({ type: "assistant", timestamp: T0, cwd: "C:\\proj", message: { role: "assistant", content: [
      { type: "thinking", thinking: "推理过程不应入信号" },
      { type: "text", text: "收到,开始排查" },
    ] } }),
    line({ type: "assistant", timestamp: T0, message: { role: "assistant", content: [
      { type: "tool_use", name: "Edit", input: { file_path: "C:\\proj\\a.ts", old_string: "c", new_string: "a\nb" } },
    ] } }),
    line({ type: "assistant", timestamp: T0, message: { role: "assistant", content: [
      { type: "tool_use", name: "Bash", input: { command: `git commit -m "fix: 修复登录超时"` } },
    ] } }),
    line({ type: "system", subtype: "turn_duration", timestamp: T0, durationMs: 1000 }),
    line({ type: "user", timestamp: T1, message: { role: "user", content: "<command-message>/report</command-message>" } }),
    line({ type: "user", timestamp: T1, isMeta: true, message: { role: "user", content: "meta 消息" } }),
    line({ type: "user", timestamp: T1, message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }, { type: "tool_result", tool_use_id: "x", content: "结果" }] } }),
    line({ type: "assistant", timestamp: T1, attributionSkill: "shine-worklog:report", message: { role: "assistant", content: [
      { type: "tool_use", name: "TaskCreate", input: { subject: "重构 getCache 支持离线" } },
      { type: "text", text: "全部完成并验证通过" },
    ] } }),
    line({ type: "system", subtype: "turn_duration", timestamp: T1 }),
    line({ type: "ai-title", aiTitle: "早期标题" }),
    line({ type: "ai-title", aiTitle: "登录超时修复" }),
    line({ type: "system", subtype: "away_summary", content: "本轮完成登录超时修复并提交。", timestamp: T1 }),
    line({ type: "attachment", timestamp: T2, attachment: { type: "hook_success" } }),
  ].join("\n");
}

describe("parseSignalEvents(逐行提取)", () => {
  test("turn 闭合/conclusion/commits/任务/文件/计数/aiTitle/away_summary", () => {
    const st = parseSignalEvents(fixtureSession(), emptySignals());
    expect(st.turns.length).toBe(2);
    expect(st.open).toBeNull();
    const t1 = st.turns[0]!;
    expect(t1.prompts).toEqual(["修复登录超时问题"]);
    expect(t1.conclusion).toBe("收到,开始排查"); // thinking 不算,最后一条 text 胜出
    expect(t1.commits).toEqual(["fix: 修复登录超时"]);
    expect(t1.files).toEqual(["C:\\proj\\a.ts"]);
    expect(t1.added).toBe(2); // "a\nb" split=2
    expect(t1.removed).toBe(1);
    const t2 = st.turns[1]!;
    expect(t2.prompts).toEqual([]); // wrapper/isMeta/interrupt 全滤
    expect(t2.conclusion).toBe("全部完成并验证通过");
    expect(t2.taskSubjects).toEqual(["重构 getCache 支持离线"]);
    expect(t2.skills).toEqual(["shine-worklog:report"]);
    expect(st.aiTitle).toBe("登录超时修复"); // 最后一条胜出
    expect(st.awaySummaries.length).toBe(1);
    expect(st.awaySummaries[0]!.text).toContain("登录超时修复");
    expect(st.toolUseCounts).toEqual({ Edit: 1, Bash: 1, TaskCreate: 1 });
    expect(st.filesChanged).toEqual(["C:\\proj\\a.ts"]);
    expect(st.cwd).toBe("C:\\proj");
    expect(st.firstAt).toBe(Date.parse(T0));
    expect(st.lastAt).toBe(Date.parse(T1)); // attachment 行无贡献
  });

  test("未闭合 turn 留在 open", () => {
    const st = parseSignalEvents(
      line({ type: "user", timestamp: T0, message: { role: "user", content: "新任务" } }) + "\n" +
      line({ type: "assistant", timestamp: T0, message: { role: "assistant", content: [{ type: "text", text: "进行中" }] } }),
      emptySignals(),
    );
    expect(st.turns.length).toBe(0);
    expect(st.open?.prompts).toEqual(["新任务"]);
    expect(st.open?.conclusion).toBe("进行中");
  });

  test("空 turn(仅 turn_duration)不入列", () => {
    const st = parseSignalEvents(line({ type: "system", subtype: "turn_duration", timestamp: T0 }), emptySignals());
    expect(st.turns.length).toBe(0);
  });

  test("增量合并:blob 往返 + 追加新行不翻倍", () => {
    const st = parseSignalEvents(fixtureSession(), emptySignals());
    const restored = parseSignalsBlob(serializeSignals(st))!;
    expect(restored.turns.length).toBe(2);
    const more = line({ type: "assistant", timestamp: T2, message: { role: "assistant", content: [
      { type: "tool_use", name: "Bash", input: { command: `git commit -m "chore: 收尾"` } },
    ] } }) + "\n" + line({ type: "system", subtype: "turn_duration", timestamp: T2 });
    parseSignalEvents(more, restored);
    expect(restored.turns.length).toBe(3);
    expect(restored.toolUseCounts.Bash).toBe(2); // 增量不重复计数
    expect(restored.lastAt).toBe(Date.parse(T2));
  });

  test("损坏 blob → null(调用方回填)", () => {
    expect(parseSignalsBlob("{oops")).toBeNull();
    expect(parseSignalsBlob(null)).toBeNull();
    expect(parseSignalsBlob('{"aiTitle":1}')).toBeNull(); // 形状不对
  });
});

describe("SignalsStore + readSignalsForApi(文件存储)", () => {
  const base = mkdtempSync(join(tmpdir(), "signals-test-"));
  const transcript = join(base, "sess1.jsonl");
  const projectId = "C--proj";
  const cwd = "C:\\proj";
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  test("首读回填 → 增量追加 → API 读取/过滤", () => {
    writeFileSync(transcript, fixtureSession(), "utf8");
    const store = new SignalsStore(base);
    store.update({ path: transcript, sessionId: "sess1", projectId }, fixtureSession(), false);

    const r = readSignalsForApi({ cwd }, base);
    expect(r.total).toBe(1);
    const s = r.sessions[0]!;
    expect(s.sessionId).toBe("sess1");
    expect(s.aiTitle).toBe("登录超时修复");
    expect(s.turns.length).toBe(2); // 无 open
    expect(s.commits).toEqual(["fix: 修复登录超时"]);
    expect(s.linesAdded).toBe(2);

    // 增量:transcript 追加,只传新行
    const tail = line({ type: "assistant", timestamp: T2, message: { role: "assistant", content: [{ type: "text", text: "收尾完成" }] } }) + "\n" +
      line({ type: "system", subtype: "turn_duration", timestamp: T2 });
    writeFileSync(transcript, fixtureSession() + "\n" + tail, "utf8");
    store.update({ path: transcript, sessionId: "sess1", projectId }, tail, false);
    const r2 = readSignalsForApi({ cwd, sessionId: "sess1" }, base);
    expect(r2.sessions[0]!.turns.length).toBe(3);
    expect(r2.sessions[0]!.turns[2]!.conclusion).toBe("收尾完成");

    // since 过滤:未来时间戳 → 排除;sessionId 精查不受 since 排除
    const future = Date.parse("2027-01-01T00:00:00.000Z");
    expect(readSignalsForApi({ cwd, since: future }, base).total).toBe(0);
    expect(readSignalsForApi({ cwd, since: future, sessionId: "sess1" }, base).total).toBe(1);
    // cwd 不匹配(同编码碰撞由文件内 cwd 精确过滤)
    expect(readSignalsForApi({ cwd: "D:\\proj", sessionId: "sess1" }, base).total).toBe(0);
    // 文件落在日期目录(首个信号事件日)
    const raw = readFileSync(join(base, projectId, "2026-08-17", "sess1.json"), "utf8");
    expect(JSON.parse(raw).turns.length).toBe(3);
  });

  test("transcript 读不出且无旧状态 → 不写空文件", () => {
    const store = new SignalsStore(base);
    const before = readSignalsForApi({ cwd }, base).total;
    store.update({ path: join(base, "不存在.jsonl"), sessionId: "ghost", projectId }, "", false);
    expect(readSignalsForApi({ cwd }, base).total).toBe(before);
  });

  test("has():有信号文件 true,未知会话 false", () => {
    const store = new SignalsStore(base);
    expect(store.has({ sessionId: "sess1", projectId })).toBe(true);
    expect(store.has({ sessionId: "nope", projectId })).toBe(false);
  });

  test("truncated 回填不翻倍(带旧状态也必须从空重建)", () => {
    writeFileSync(transcript, fixtureSession(), "utf8");
    const store = new SignalsStore(base);
    store.update({ path: transcript, sessionId: "tr1", projectId }, fixtureSession(), false);
    // 文件被截断(理论上变小)后再消费:旧状态存在 + truncated=true → 若误叠加会 Edit=2/turns=4
    store.update({ path: transcript, sessionId: "tr1", projectId }, "", true);
    const s = readSignalsForApi({ cwd, sessionId: "tr1" }, base).sessions[0]!;
    expect(s.toolUseCounts.Edit).toBe(1);
    expect(s.turns.length).toBe(2);
  });

  test("transcript 删除后:已有信号保留不误清", () => {
    writeFileSync(transcript, fixtureSession(), "utf8");
    const store = new SignalsStore(base);
    store.update({ path: transcript, sessionId: "tr2", projectId }, fixtureSession(), false);
    rmSync(transcript);
    store.update({ path: transcript, sessionId: "tr2", projectId }, "", false);
    const s = readSignalsForApi({ cwd, sessionId: "tr2" }, base).sessions[0]!;
    expect(s.turns.length).toBe(2); // 旧文件原样保留
  });
});
