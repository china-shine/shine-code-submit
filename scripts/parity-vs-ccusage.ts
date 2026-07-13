// 对拍脚本:shine-code-submit daemon /api/report vs ccusage session -j
// 以 ccusage 为标准,逐 session 逐字段(input/output/cacheCreation/cacheRead)对比。
// 静止 session(lastActive > 10min 前)应零差异;活跃 session 允许因 transcript 在涨而出现差异。
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TOKEN = process.env.TOKEN!;
const DAEMON = "http://127.0.0.1:36666";
const CCFILE = process.env.CCFILE ?? "ccusage-all.json";
const STATIC_MS = 10 * 60 * 1000; // 10 分钟内无活动视为活跃

// ---- ccusage ----
const cc = await (await Bun.file(CCFILE).json()) as {
  session: Array<{
    period: string; // sessionId
    inputTokens: number; outputTokens: number;
    cacheCreationTokens: number; cacheReadTokens: number;
    totalTokens: number; totalCost: number;
  }>;
  totals: unknown;
};
const ccMap = new Map<string, { input: number; output: number; cacheCreation: number; cacheRead: number; total: number }>();
for (const s of cc.session) {
  ccMap.set(s.period, {
    input: s.inputTokens, output: s.outputTokens,
    cacheCreation: s.cacheCreationTokens, cacheRead: s.cacheReadTokens,
    total: s.totalTokens,
  });
}

// ---- daemon report ----
const rep = await (await fetch(`${DAEMON}/api/report`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json() as {
  projects: Array<{
    cwd: string; name: string; sessionCount: number;
    sessions: Array<{ sessionId: string; lastActive: number; tokenTotal: { input: number; output: number; cacheCreation: number; cacheRead: number } }>;
    totalTokens: { input: number; output: number; cacheCreation: number; cacheRead: number };
  }>;
  totals: { sessions: number; tokens: { input: number; output: number; cacheCreation: number; cacheRead: number } };
};
const dMap = new Map<string, { input: number; output: number; cacheCreation: number; cacheRead: number; lastActive: number; cwd: string }>();
for (const p of rep.projects) {
  for (const s of p.sessions) {
    dMap.set(s.sessionId, {
      input: s.tokenTotal.input, output: s.tokenTotal.output,
      cacheCreation: s.tokenTotal.cacheCreation, cacheRead: s.tokenTotal.cacheRead,
      lastActive: s.lastActive, cwd: p.cwd,
    });
  }
}

// ---- 判断某 session 是否带 subagents(父目录下有 <sid>/subagents/) ----
function hasSubagentsSimple(sessionId: string): boolean {
  const root = join(homedir(), ".claude", "projects");
  try {
    for (const proj of readdirSync(root)) {
      if (existsSync(join(root, proj, sessionId, "subagents"))) return true;
    }
  } catch {}
  return false;
}

// ---- 对齐对比 ----
const now = Date.now();
const allIds = new Set<string>([...ccMap.keys(), ...dMap.keys()]);
let bothMatch = 0, bothDiff = 0, onlyDaemon = 0, onlyCcusage = 0;
let staticMatch = 0, staticDiff = 0;
const diffs: Array<{ id: string; static: boolean; subagents: boolean; cwd: string; cc: Record<string, number>; d: Record<string, number>; delta: Record<string, number> }> = [];
const onlyD: string[] = [];
const onlyC: string[] = [];

for (const id of allIds) {
  const c = ccMap.get(id);
  const d = dMap.get(id);
  if (c && d) {
    const isStatic = d.lastActive < now - STATIC_MS;
    const sub = hasSubagentsSimple(id);
    const same = c.input === d.input && c.output === d.output && c.cacheCreation === d.cacheCreation && c.cacheRead === d.cacheRead;
    if (same) {
      bothMatch++;
      if (isStatic) staticMatch++;
    } else {
      bothDiff++;
      if (isStatic) staticDiff++;
      diffs.push({
        id, static: isStatic, subagents: sub, cwd: d.cwd,
        cc: { input: c.input, output: c.output, cacheCreation: c.cacheCreation, cacheRead: c.cacheRead, total: c.total },
        d: { input: d.input, output: d.output, cacheCreation: d.cacheCreation, cacheRead: d.cacheRead, total: d.input + d.output + d.cacheCreation + d.cacheRead },
        delta: {
          input: d.input - c.input, output: d.output - c.output,
          cacheCreation: d.cacheCreation - c.cacheCreation, cacheRead: d.cacheRead - c.cacheRead,
        },
      });
    }
  } else if (d && !c) { onlyDaemon++; onlyD.push(id); }
  else if (c && !d) { onlyCcusage++; onlyC.push(id); }
}

// ---- 全局总量对比 ----
const ccTot = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
for (const s of cc.session) { ccTot.input += s.inputTokens; ccTot.output += s.outputTokens; ccTot.cacheCreation += s.cacheCreationTokens; ccTot.cacheRead += s.cacheReadTokens; }
const dTot = rep.totals.tokens;

console.log(JSON.stringify({
  summary: {
    ccusage_sessions: cc.session.length,
    daemon_sessions: dMap.size,
    both_match: bothMatch,
    both_diff: bothDiff,
    only_daemon: onlyDaemon,
    only_ccusage: onlyCcusage,
    static_match: staticMatch,
    static_diff: staticDiff,
  },
  totals: {
    ccusage: { ...ccTot, total: ccTot.input + ccTot.output + ccTot.cacheCreation + ccTot.cacheRead },
    daemon: { ...dTot, total: dTot.input + dTot.output + dTot.cacheCreation + dTot.cacheRead },
    delta: {
      input: dTot.input - ccTot.input, output: dTot.output - ccTot.output,
      cacheCreation: dTot.cacheCreation - ccTot.cacheCreation, cacheRead: dTot.cacheRead - ccTot.cacheRead,
    },
  },
  diffs: diffs.sort((a, b) => Number(a.static) - Number(b.static)), // 活跃在前
  only_daemon_ids: onlyD,
  only_ccusage_ids: onlyC,
}, null, 2));
