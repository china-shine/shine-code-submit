// 保真度审计:信号提取 vs 原始 transcript 逐维度对比(独立解析器,不复用 signals.ts)
// 对齐方式:以信号快照的 lastAt 为截止,原始日志只统计 timestamp <= 截止的行。
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SIG_ROOT = join(process.env.LOCALAPPDATA!, "shine-worklog", "signals");
const RAW_ROOT = join(process.env.USERPROFILE!, ".claude", "projects");

const isRealPrompt = (t: string) => {
  const s = t.trim();
  return s.length > 1 && s.length <= 500 && !s.startsWith("<") && !/^Caveat:/i.test(s) && !s.startsWith("[Request interrupted");
};
const countLines = (s: unknown) => (typeof s === "string" && s.length ? s.split("\n").length : 0);
const commitSubject = (cmd: string): string | null => {
  if (!/git\s+commit/.test(cmd)) return null;
  const h = /<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1/.exec(cmd);
  const q = /-m\s+"((?:[^"\\]|\\.)*)"/.exec(cmd) ?? /-m\s+'([^']*)'/.exec(cmd);
  const raw = h?.[2] ?? q?.[1];
  if (!raw) return null;
  const first = raw.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  return first ? first.replace(/\\"/g, '"') : null;
};

interface RawTurn {
  endMs: number;
  prompts: string[]; // 全文,未截断
  lastText: string | null; // 最后一条 assistant text 全文
  commits: string[];
  taskSubjects: string[];
  files: string[];
  added: number; removed: number;
  toolCounts: Record<string, number>;
}

function parseRaw(raw: string, cutoffMs: number) {
  const turns: RawTurn[] = [];
  let cur: RawTurn | null = null;
  const open = (ts: number) => (cur ??= { endMs: ts, prompts: [], lastText: null, commits: [], taskSubjects: [], files: [], added: 0, removed: 0, toolCounts: {} });
  const aiTitles: string[] = [];
  const aways: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    const ts = typeof ev.timestamp === "string" ? Date.parse(ev.timestamp) : 0;
    if (ts > cutoffMs) continue; // 截止对齐
    if (ev.type === "ai-title" && typeof ev.aiTitle === "string") { aiTitles.push(ev.aiTitle); continue; }
    if (ev.type === "system" && ev.subtype === "away_summary" && typeof ev.content === "string" && ev.content.trim()) { aways.push(ev.content.trim()); continue; }
    if (ev.type === "system" && ev.subtype === "turn_duration") {
      if (cur && (cur.prompts.length || cur.lastText || cur.commits.length || cur.taskSubjects.length || cur.files.length || cur.added + cur.removed > 0)) turns.push(cur);
      cur = null;
      continue;
    }
    const m = ev.message; if (!m) continue;
    if (m.role === "user" && !ev.isMeta) {
      const t = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n") : "";
      if (isRealPrompt(t)) { const o = open(ts); o.prompts.push(t.trim()); }
    } else if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (!b) continue;
        if (b.type === "text" && typeof b.text === "string" && b.text.trim()) open(ts).lastText = b.text.trim();
        else if (b.type === "tool_use") {
          const o = open(ts);
          const n = b.name ?? "unknown";
          o.toolCounts[n] = (o.toolCounts[n] ?? 0) + 1;
          const inp = b.input ?? {};
          if (n === "Bash" && typeof inp.command === "string") { const s = commitSubject(inp.command); if (s) o.commits.push(s); }
          if (["Edit", "Write", "MultiEdit"].includes(n) && typeof inp.file_path === "string" && !o.files.includes(inp.file_path)) o.files.push(inp.file_path);
          if (n === "Edit") { o.added += countLines(inp.new_string); o.removed += countLines(inp.old_string); }
          if (n === "Write") o.added += countLines(inp.content);
          if (n === "MultiEdit" && Array.isArray(inp.edits)) for (const e of inp.edits) { o.added += countLines(e.new_string); o.removed += countLines(e.old_string); }
          if ((n === "TaskCreate" || n === "TaskUpdate") && typeof inp.subject === "string" && inp.subject.trim()) o.taskSubjects.push(inp.subject.trim());
          if (n === "TodoWrite" && Array.isArray(inp.todos)) for (const t of inp.todos) if (typeof t?.subject === "string" && t.subject.trim()) o.taskSubjects.push(t.subject.trim());
        }
      }
    }
  }
  if (cur && (cur.prompts.length || cur.lastText)) turns.push(cur);
  return { turns, aiTitles, aways };
}

for (const [proj, day, sid, label] of [
  ["C--Users-ren-Desktop-workspace-livesetting", "2026-08-17", "e2172434-0ab6-479e-8315-721624be6efe", "上午·周报排查+调研(已结束)"],
  ["C--Users-ren-Desktop-workspace-livesetting", "2026-08-17", "bf50676a-3d9a-4968-8efb-91a5a3d52874", "上午10:30起·signals开发(当前会话)"],
] as const) {
  const sig = JSON.parse(readFileSync(join(SIG_ROOT, proj, day, sid + ".json"), "utf8"));
  const cutoff = Math.max(sig.lastAt ?? 0, ...sig.turns.map((t: any) => t.endMs), sig.open?.endMs ?? 0);
  const raw = readFileSync(join(RAW_ROOT, proj, sid + ".jsonl"), "utf8");
  const truth = parseRaw(raw, cutoff);
  const sigTurns = [...sig.turns, ...(sig.open ? [sig.open] : [])];

  console.log(`\n████ ${label} ${sid.slice(0, 8)} ████`);
  console.log(`原始 jsonl: ${(raw.length / 1e6).toFixed(1)}MB | 信号体积: ${(JSON.stringify(sig).length / 1024).toFixed(0)}KB | 对齐截止: ${new Date(cutoff).toISOString().slice(11, 19)}`);
  console.log(`\n[turns] 原始 ${truth.turns.length} vs 信号 ${sigTurns.length} ${truth.turns.length === sigTurns.length ? "✅" : "⚠️"}`);

  // conclusion 保真:逐 turn 比对
  let conclExact = 0, conclTrunc = 0, truncLostChars = 0, conclMissing = 0;
  const truncSamples: string[] = [];
  for (let i = 0; i < Math.min(truth.turns.length, sigTurns.length); i++) {
    const full = truth.turns[i]!.lastText;
    const got = sigTurns[i]?.conclusion ?? null;
    if (full === null && got === null) continue;
    if (got === null) { conclMissing++; continue; }
    if (full === got) conclExact++;
    else if (full && got && full.startsWith(got)) { conclTrunc++; truncLostChars += full.length - got.length; if (truncSamples.length < 2) truncSamples.push(`      摘信号:…${got.slice(-50)}\n      被截去:…${full.slice(got.length, got.length + 120)}…(共丢 ${full.length - got.length} 字)`); }
    else { console.log(`  ⚠️ turn${i} conclusion 内容不一致!\n    原始: ${JSON.stringify((full ?? "").slice(0, 60))}\n    信号: ${JSON.stringify((got ?? "").slice(0, 60))}`); }
  }
  console.log(`[conclusion] 完整=${conclExact} 截断=${conclTrunc}(共丢 ${truncLostChars} 字) 丢失=${conclMissing} ${conclMissing === 0 ? "✅" : "⚠️"}`);
  truncSamples.forEach((s) => console.log(s));

  // prompts 保真
  let pExact = 0, pTrunc = 0, pDedup = 0;
  const rawP = truth.turns.flatMap((t) => t.prompts);
  const sigP = sigTurns.flatMap((t: any) => t.prompts ?? []);
  for (const rp of rawP) {
    const norm = rp.replace(/\s+/g, " ").slice(0, 200);
    if (sigP.includes(norm)) pExact++;
    else if (sigP.some((sp: string) => norm.startsWith(sp))) pTrunc++;
    else pDedup++;
  }
  console.log(`[prompts] 原始 ${rawP.length} 条 | 信号 ${sigP.length} 条 | 完整=${pExact} 截断(>200字)=${pTrunc} 同turn去重/差异=${pDedup}`);

  // commits / tasks / files / 行数 / 工具计数
  const rawC = [...new Set(truth.turns.flatMap((t) => t.commits))];
  const sigC = [...new Set(sigTurns.flatMap((t: any) => t.commits ?? []))];
  console.log(`[commits] 原始去重 ${rawC.length} vs 信号 ${sigC.length} ${rawC.length === sigC.length ? "✅" : "⚠️ 差: " + JSON.stringify(rawC.filter((c) => !sigC.includes(c)))}`);
  const rawT = [...new Set(truth.turns.flatMap((t) => t.taskSubjects))];
  const sigT = [...new Set(sigTurns.flatMap((t: any) => t.taskSubjects ?? []))];
  console.log(`[taskSubjects] 原始 ${rawT.length} vs 信号 ${sigT.length} ${rawT.length === sigT.length ? "✅" : "⚠️ 差: " + JSON.stringify(rawT.filter((c) => !sigT.includes(c)).slice(0, 3))}`);
  const rawF = [...new Set(truth.turns.flatMap((t) => t.files))];
  const sigF = [...new Set(sig.filesChanged ?? [])];
  console.log(`[files] 原始 ${rawF.length} vs 信号(全会上限50) ${sigF.length} | 信号缺: ${JSON.stringify(rawF.filter((f) => !sigF.includes(f)).slice(0, 3))}`);
  const rawAdded = truth.turns.reduce((a, t) => a + t.added, 0), rawRemoved = truth.turns.reduce((a, t) => a + t.removed, 0);
  const sigAdded = sigTurns.reduce((a, t: any) => a + (t.added ?? 0), 0), sigRemoved = sigTurns.reduce((a, t: any) => a + (t.removed ?? 0), 0);
  console.log(`[行数] added 原始 ${rawAdded} vs 信号 ${sigAdded} | removed 原始 ${rawRemoved} vs 信号 ${sigRemoved} ${rawAdded === sigAdded && rawRemoved === sigRemoved ? "✅" : "⚠️"}`);
  const rawTC: Record<string, number> = {};
  for (const t of truth.turns) for (const [k, v] of Object.entries(t.toolCounts)) rawTC[k] = (rawTC[k] ?? 0) + v;
  const tcDiff = Object.entries(rawTC).filter(([k, v]) => (sig.toolUseCounts?.[k] ?? 0) !== v);
  console.log(`[toolUseCounts] ${Object.keys(rawTC).length} 种工具 ${tcDiff.length === 0 ? "✅ 全等" : "⚠️ 差异: " + JSON.stringify(tcDiff.map(([k, v]) => `${k}:${v}vs${sig.toolUseCounts?.[k] ?? 0}`))}`);
  console.log(`[ai-title] 原始最后: ${JSON.stringify(truth.aiTitles.at(-1) ?? null)} | 信号: ${JSON.stringify(sig.aiTitle)} ${truth.aiTitles.at(-1) === sig.aiTitle ? "✅" : "⚠️"}`);
  const cleanA = (s: string) => s.replace(/ *\(disable recaps in \/config\)$/, "");
  console.log(`[away] 原始 ${truth.aways.length} vs 信号 ${sig.awaySummaries.length} ${truth.aways.length === sig.awaySummaries.length ? "✅" : "⚠️"} | 文本一致性: ${truth.aways.every((a, i) => cleanA(a).slice(0, 600) === (sig.awaySummaries[i]?.text ?? "")) ? "✅" : "(顺序/截断差异,抽样核对)"}`);
}
