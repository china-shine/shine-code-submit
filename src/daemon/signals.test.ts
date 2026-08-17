import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, utimesSync, statSync } from "node:fs";
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
    line({ type: "assistant", timestamp: T1, cwd: "C:\\proj\\sub", attributionSkill: "shine-worklog:report", message: { role: "assistant", content: [
      { type: "tool_use", name: "TaskCreate", input: { subject: "重构 getCache 支持离线" } },
      { type: "text", text: "全部完成并验证通过" },
    ] } }),
    line({ type: "system", subtype: "turn_duration", timestamp: T1 }),
    line({ type: "ai-title", aiTitle: "早期标题" }),
    line({ type: "ai-title", aiTitle: "登录超时修复" }),
    line({ type: "system", subtype: "away_summary", content: "本轮完成登录超时修复并提交。 (disable recaps in /config)", timestamp: T1 }),
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
    expect(st.awaySummaries[0]!.text).toBe("本轮完成登录超时修复并提交。"); // UI 提示尾巴被清掉
    expect(st.toolUseCounts).toEqual({ Edit: 1, Bash: 1, TaskCreate: 1 });
    expect(st.filesChanged).toEqual(["C:\\proj\\a.ts"]);
    expect(st.cwd).toBe("C:\\proj"); // 首条 cwd 胜出(中途 cd 子目录不覆盖,否则 API 按 cwd 过滤查不到)
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

  test("同 sessionId 双文件(备份恢复等外部来源)→ API 只返回新鲜者", () => {
    // 手造同 session 两份:旧(2026-01-01,turns 少)与新(2026-08-17,已有 sess1 是新鲜范例)——直接造两个
    const oldDir = join(base, projectId, "2026-01-01");
    mkdirSync(oldDir, { recursive: true });
    const stale = { ...emptySignals(), cwd, firstAt: 1, lastAt: 1, turns: [{ startMs: 1, endMs: 1, prompts: ["旧"], conclusion: "旧结论", commits: [], taskSubjects: [], files: [], added: 0, removed: 0, skills: [] }] };
    writeFileSync(join(oldDir, "sess1.json"), JSON.stringify(stale), "utf8"); // 与已建的 sess1 同 id
    const r = readSignalsForApi({ cwd, sessionId: "sess1" }, base);
    expect(r.total).toBe(1);
    expect(r.sessions[0]!.turns.length).toBeGreaterThanOrEqual(2); // 新鲜者(原 sess1 的内容)
    rmSync(join(oldDir, "sess1.json")); // 清理,不影响后续断言
  });

  test("空 transcript(0字节)不写空信号文件", () => {
    const empty = join(base, "empty.jsonl");
    writeFileSync(empty, "", "utf8");
    const store = new SignalsStore(base);
    const before = readSignalsForApi({ cwd }, base).total;
    store.update({ path: empty, sessionId: "empty1", projectId }, "", false);
    expect(readSignalsForApi({ cwd }, base).total).toBe(before);
    expect(store.has({ sessionId: "empty1", projectId })).toBe(false);
  });

  test("归属日期漂移(firstAt 后到)→ 迁移到正确目录并删旧文件,无双份", () => {
    // 手造 firstAt=0 但有内容的信号,落在错误日期目录(2026-01-01)
    const oldDir = join(base, projectId, "2026-01-01");
    mkdirSync(oldDir, { recursive: true });
    const handcraft = {
      ...emptySignals(),
      cwd,
      turns: [{ startMs: 0, endMs: 0, prompts: ["旧内容"], conclusion: null, commits: [], taskSubjects: [], files: [], added: 0, removed: 0, skills: [] }],
    };
    writeFileSync(join(oldDir, "drift.json"), JSON.stringify(handcraft), "utf8");
    writeFileSync(transcript, fixtureSession(), "utf8");
    const store = new SignalsStore(base);
    store.update({ path: transcript, sessionId: "drift", projectId }, fixtureSession(), false);
    expect(existsSync(join(oldDir, "drift.json"))).toBe(false); // 旧文件已删,不残留
    const r = readSignalsForApi({ cwd, sessionId: "drift" }, base);
    expect(r.total).toBe(1); // 只有一份(2026-08-17 目录)
    expect(r.sessions[0]!.turns.length).toBe(3); // 旧 turn + fixture 2 turn
  });

  test("信号落后于 transcript(消费中途被杀/旧版消费过)→ 无新行也全量重建自愈", () => {
    writeFileSync(transcript, fixtureSession(), "utf8");
    const store = new SignalsStore(base);
    store.update({ path: transcript, sessionId: "heal", projectId }, fixtureSession(), false);
    // 模拟:transcript 又长了一段(如被旧版 daemon 消费,新代码拿不到 newLines),信号文件 mtime 落后 >5s
    const tail = line({ type: "assistant", timestamp: T2, message: { role: "assistant", content: [{ type: "text", text: "被杀前丢失的结论" }] } }) + "\n" +
      line({ type: "system", subtype: "turn_duration", timestamp: T2 });
    writeFileSync(transcript, fixtureSession() + "\n" + tail, "utf8");
    const sigFile = join(base, projectId, "2026-08-17", "heal.json");
    const past = new Date(Date.now() - 10_000);
    utimesSync(sigFile, past, past);
    const srcM = statSync(transcript).mtimeMs;
    // needsConsume 应报告落后(兜底全扫据此标脏)
    expect(store.needsConsume({ sessionId: "heal", projectId, transcriptMtimeMs: srcM })).toBe(true);
    // 消费者路径:update 无新行 → 落后重建
    store.update({ path: transcript, sessionId: "heal", projectId }, "", false);
    const s = readSignalsForApi({ cwd, sessionId: "heal" }, base).sessions[0]!;
    expect(s.turns.length).toBe(3); // 丢失的 turn 补回
    expect(s.turns[2]!.conclusion).toBe("被杀前丢失的结论");
    // 自愈后不再落后
    expect(store.needsConsume({ sessionId: "heal", projectId, transcriptMtimeMs: srcM })).toBe(false);
  });
});
