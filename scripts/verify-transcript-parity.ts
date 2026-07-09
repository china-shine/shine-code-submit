// 对齐 ccusage 的 token 统计验证脚本（无测试框架，bun 直接跑）。
//
// 用法:
//   bun run scripts/verify-transcript-parity.ts            # 跑合成用例（去重/校验/细分门）
//   bun run scripts/verify-transcript-parity.ts <a.jsonl>  # 打印该 transcript 的 4 字段，供与 ccusage 对拍
//
// 合成用例复刻 ccusage rust/crates/ccusage/src/adapter/claude/mod.rs 的两条去重测试,
// 外加 cache_creation 5m/1h 细分归并、null 字段丢弃、非 semver version 丢弃等门。
// 真实对拍: 选一个无子代理的 session, 与 `ccusage claude session --json` 该 session 字段逐项比对。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sumTranscriptUsage, sumSessionUsage } from "../src/daemon/transcript";
import type { TokenUsage } from "../src/shared/types";

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean): void {
  if (cond) {
    passed++;
    console.log("  ok   " + name);
  } else {
    failed++;
    console.log("  FAIL " + name);
  }
}

function eq(name: string, got: TokenUsage, expected: TokenUsage): void {
  const same =
    got.input === expected.input &&
    got.output === expected.output &&
    got.cacheCreation === expected.cacheCreation &&
    got.cacheRead === expected.cacheRead;
  assert(
    `${name}  (input ${got.input}/${expected.input} output ${got.output}/${expected.output} cc ${got.cacheCreation}/${expected.cacheCreation} cr ${got.cacheRead}/${expected.cacheRead})`,
    same,
  );
}

function runFixture(name: string, lines: string[], expected: TokenUsage): void {
  const dir = mkdtempSync(join(tmpdir(), "ccusage-parity-"));
  const path = join(dir, "t.jsonl");
  writeFileSync(path, lines.join("\n"));
  try {
    eq(name, sumTranscriptUsage(path), expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 构造父 transcript + subagents/<name>.jsonl 目录结构，验证 sumSessionUsage（父+子代理归并）。 */
function runSessionFixture(
  name: string,
  parentLines: string[],
  subagents: Record<string, string[]>,
  expected: TokenUsage,
): void {
  const dir = mkdtempSync(join(tmpdir(), "ccusage-session-"));
  const parentPath = join(dir, "session.jsonl");
  writeFileSync(parentPath, parentLines.join("\n"));
  const subDir = join(dir, "session", "subagents");
  mkdirSync(subDir, { recursive: true });
  for (const [fname, lines] of Object.entries(subagents)) {
    writeFileSync(join(subDir, fname), lines.join("\n"));
  }
  try {
    eq(name, sumSessionUsage(parentPath), expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface LineOpts {
  messageId: string;
  requestId: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreationFlat?: number;
  cacheCreation5m?: number;
  cacheCreation1h?: number;
  isSidechain?: boolean;
  speed?: string;
  version?: string;
  timestamp?: string;
  model?: string | null;
}

/** 构造一条能通过 ccusage 全部门的合法 transcript 行。 */
function mkLine(o: LineOpts): string {
  const usage: Record<string, unknown> = {
    input_tokens: o.input ?? 0,
    output_tokens: o.output ?? 0,
    cache_creation_input_tokens: o.cacheCreationFlat ?? 0,
    cache_read_input_tokens: o.cacheRead ?? 0,
  };
  if (o.cacheCreation5m != null || o.cacheCreation1h != null) {
    usage.cache_creation = {
      ephemeral_5m_input_tokens: o.cacheCreation5m ?? 0,
      ephemeral_1h_input_tokens: o.cacheCreation1h ?? 0,
    };
  }
  if (o.speed) usage.speed = o.speed;
  const message: Record<string, unknown> = {
    id: o.messageId,
    model: o.model ?? "claude-sonnet-4-20250514",
    usage,
  };
  if (o.model === null) message.model = null;
  return JSON.stringify({
    sessionId: "session-a",
    timestamp: o.timestamp ?? "2026-03-29T07:00:00.000Z",
    version: o.version ?? "1.0.0",
    requestId: o.requestId,
    isSidechain: o.isSidechain === true,
    message,
  });
}

console.log("合成用例（对齐 ccusage adapter/claude/mod.rs）:");

// 1. sidechain 重放：父条目保留、50000 的重放被丢弃、保留 700 的子答案。
//    ccusage: keeps_parent_usage_when_sidechain_replays_message_with_new_request_id
runFixture(
  "sidechain 重放保留父条目",
  [
    mkLine({ messageId: "msg-parent", requestId: "req-parent", cacheRead: 20, output: 10 }),
    mkLine({
      messageId: "msg-parent",
      requestId: "req-sidechain-replay",
      isSidechain: true,
      cacheRead: 50_000,
      output: 10,
    }),
    mkLine({
      messageId: "msg-sidechain-answer",
      requestId: "req-sidechain-answer",
      isSidechain: true,
      cacheRead: 700,
      output: 30,
    }),
  ],
  { input: 0, output: 40, cacheCreation: 0, cacheRead: 720 },
);

// 2. 父后到替换 sidechain 重放，索引刷新；随后同 id+reqid 的更小 total 不覆盖。
//    ccusage: refreshes_dedupe_indexes_when_parent_replaces_sidechain_replay
runFixture(
  "父后到替换 sidechain 重放 + 索引刷新",
  [
    mkLine({
      messageId: "msg-parent",
      requestId: "req-sidechain-replay",
      isSidechain: true,
      cacheRead: 50_000,
      output: 10,
    }),
    mkLine({ messageId: "msg-parent", requestId: "req-parent", cacheRead: 20, output: 10 }),
    mkLine({ messageId: "msg-parent", requestId: "req-parent", cacheRead: 5, output: 5 }),
  ],
  { input: 0, output: 10, cacheCreation: 0, cacheRead: 20 },
);

// 3. cache_creation 5m/1h 细分归并：breakdown 存在时用 5m+1h，忽略扁平字段(999)。
runFixture(
  "cache_creation 5m+1h 细分归并",
  [
    mkLine({
      messageId: "m1",
      requestId: "r1",
      input: 1,
      output: 2,
      cacheCreationFlat: 999,
      cacheCreation5m: 10,
      cacheCreation1h: 20,
      cacheRead: 30,
    }),
  ],
  { input: 1, output: 2, cacheCreation: 30, cacheRead: 30 },
);

// 4. 无细分时回退扁平 cache_creation_input_tokens。
runFixture(
  "无细分回退扁平 cache_creation",
  [
    mkLine({
      messageId: "m1",
      requestId: "r1",
      cacheCreationFlat: 100,
      cacheRead: 5,
    }),
  ],
  { input: 0, output: 0, cacheCreation: 100, cacheRead: 5 },
);

// 5. null 黑名单：model 为 null 的行整行丢弃，不计入。
runFixture(
  "model=null 行被丢弃",
  [
    mkLine({ messageId: "m1", requestId: "r1", output: 100 }),
    mkLine({ messageId: "m2", requestId: "r2", output: 200, model: null }),
  ],
  { input: 0, output: 100, cacheCreation: 0, cacheRead: 0 },
);

// 6. 非 semver version 的行丢弃。
runFixture(
  "version 非 semver 行被丢弃",
  [
    mkLine({ messageId: "m1", requestId: "r1", output: 100 }),
    mkLine({ messageId: "m2", requestId: "r2", output: 200, version: "abc" }),
  ],
  { input: 0, output: 100, cacheCreation: 0, cacheRead: 0 },
);

// 7. 同 messageId+requestId 直接去重（取 total 更大者）。
runFixture(
  "同 id+requestId 取 total 更大者",
  [
    mkLine({ messageId: "m1", requestId: "r1", input: 10, output: 5 }),
    mkLine({ messageId: "m1", requestId: "r1", input: 1000, output: 1000 }),
  ],
  { input: 1000, output: 1000, cacheCreation: 0, cacheRead: 0 },
);

// 8. 无 usage 标记 / 无 message 的行跳过 → 空结果。
runFixture(
  "无 usage 标记行跳过",
  ['{"timestamp":"2026-03-29T07:00:00.000Z","message":{"id":"m1","model":"x"}}'],
  { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
);

// 9. 子代理 transcript 归并到父 session（对齐 ccusage session 口径）。
runSessionFixture(
  "子代理 transcript 归并",
  [mkLine({ messageId: "parent-msg", requestId: "pr", input: 100, output: 10 })],
  { "agent-1.jsonl": [mkLine({ messageId: "sub-msg", requestId: "sr", input: 200, output: 20 })] },
  { input: 300, output: 30, cacheCreation: 0, cacheRead: 0 },
);

// 10. 父+子代理跨文件去重：同 messageId+requestId 只算一次。
runSessionFixture(
  "父+子代理跨文件去重",
  [mkLine({ messageId: "dup", requestId: "rd", input: 100, output: 10 })],
  { "agent-1.jsonl": [mkLine({ messageId: "dup", requestId: "rd", input: 100, output: 10 })] },
  { input: 100, output: 10, cacheCreation: 0, cacheRead: 0 },
);

console.log(`\n合成用例: ${passed} 通过, ${failed} 失败`);

// 真实 transcript 对拍模式：传一个 .jsonl 路径，打印 4 字段。
const arg = process.argv[2];
if (arg) {
  const t = sumTranscriptUsage(arg);
  const s = sumSessionUsage(arg);
  const tot = (u: TokenUsage) => u.input + u.output + u.cacheCreation + u.cacheRead;
  console.log("\n=== sumTranscriptUsage (单文件) ===");
  console.log(
    `input=${t.input} output=${t.output} cacheCreation=${t.cacheCreation} cacheRead=${t.cacheRead} total=${tot(t)}`,
  );
  console.log("=== sumSessionUsage (父+subagents，对齐 ccusage session) ===");
  console.log(
    `input=${s.input} output=${s.output} cacheCreation=${s.cacheCreation} cacheRead=${s.cacheRead} total=${tot(s)}`,
  );
  console.log("对比: ccusage claude session --json 中该 session 的对应字段");
}

if (failed > 0) process.exit(1);
