// 第三轮:决定性内容验证 —— git commit / 任务工具 / turn 边界 / 每 turn 最后一条 assistant 文本
const f = process.argv[2];
const raw = await Bun.file(f).text();
const lines = raw.split("\n").filter((l) => l.trim());
const commits: string[] = [];
const taskTools: any[] = [];
const turnEnds: number[] = [];
const lastTextPerTurn: string[] = [];
let curTurnTexts: string[] = [];
const awaySummaries: string[] = [];
let plainPrompts: { ts: string; text: string }[] = [];
for (const line of lines) {
  let ev: any;
  try { ev = JSON.parse(line); } catch { continue; }
  if (ev.type === "system" && ev.subtype === "turn_duration") { turnEnds.push(ev.durationMs); if (curTurnTexts.length) { lastTextPerTurn.push(curTurnTexts[curTurnTexts.length - 1]); curTurnTexts = []; } }
  if (ev.type === "system" && ev.subtype === "away_summary" && ev.content) awaySummaries.push(ev.content);
  const content = ev.message?.content;
  if (!Array.isArray(content)) continue;
  if (ev.message.role === "assistant") {
    for (const b of content) {
      if (b?.type === "tool_use") {
        if (b.name === "Bash" && /git\s+commit/.test(String(b.input?.command ?? ""))) commits.push(String(b.input.command).slice(0, 150).replace(/\n/g, " "));
        if (/^(TaskCreate|TaskUpdate|TodoWrite)$/.test(b.name) && taskTools.length < 3) taskTools.push({ tool: b.name, subject: b.input?.subject ?? b.input?.todos?.[0]?.subject ?? b.input });
      }
      if (b?.type === "text" && b.text?.trim()) curTurnTexts.push(b.text);
    }
  }
  if (ev.message.role === "user" && !ev.isMeta) {
    const t = typeof content === "string" ? content : content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join(" ");
    if (t?.trim() && !t.trim().startsWith("<")) plainPrompts.push({ ts: ev.timestamp ?? "", text: t.trim().slice(0, 60).replace(/\n/g, " ") });
  }
}
console.log(`===== ${f.split(/[\\/]/).pop()} =====`);
console.log(`\ngit commit 命令 ${commits.length} 个:`); commits.slice(0, 3).forEach((c) => console.log("  " + c));
console.log(`\n任务工具样例:`); taskTools.forEach((t) => console.log("  " + JSON.stringify(t).slice(0, 150)));
console.log(`\nturn 数(${turnEnds.length}), away_summary ${awaySummaries.length} 条(覆盖率 ${((awaySummaries.length / Math.max(1, turnEnds.length)) * 100).toFixed(0)}%)`);
console.log(`\n每 turn 最后一条 assistant 文本(前5个,截80字):`);
lastTextPerTurn.slice(0, 5).forEach((t) => console.log("  · " + t.slice(0, 80).replace(/\n/g, " ")));
console.log(`\n真实用户 prompt ${plainPrompts.length} 条(时间升序前6):`);
plainPrompts.slice(0, 6).forEach((p) => console.log(`  [${(p.ts || "").slice(11, 16)}] ${p.text}`));
