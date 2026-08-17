// 深挖特殊 type 行的内容样例:ai-title / stop_hook_summary / away_summary / last-prompt / attachment / other-wrapper
const f = process.argv[2];
const raw = await Bun.file(f).text();
const lines = raw.split("\n").filter((l) => l.trim());
const grab = {
  "ai-title": [] as any[], "system/stop_hook_summary": [] as any[], "system/away_summary": [] as any[],
  "last-prompt": [] as any[], attachment: [] as any[], otherWrapper: [] as any[], attribution: {} as any,
};
for (const line of lines) {
  let ev: any;
  try { ev = JSON.parse(line); } catch { continue; }
  const key = ev.subtype ? `${ev.type}/${ev.subtype}` : ev.type;
  if (key in grab && Array.isArray((grab as any)[key]) && (grab as any)[key].length < 2) (grab as any)[key].push(ev);
  if (ev.type === "attachment" && grab.attachment.length < 3) grab.attachment.push(ev);
  if (ev.attributionSkill) grab.attribution[ev.attributionSkill] = (grab.attribution[ev.attributionSkill] ?? 0) + 1;
  const c = ev.message?.content;
  if (ev.message?.role === "user" && typeof c === "string" && c.trim().startsWith("<") &&
    !/^<(command-name|local-command-stdout|system-reminder|task-notification|bash|user-memory|artifact)/.test(c.trim()) &&
    grab.otherWrapper.length < 3) grab.otherWrapper.push(c.slice(0, 200));
}
const brief = (o: any) => JSON.stringify(o, (k, v) => (typeof v === "string" && v.length > 260 ? v.slice(0, 260) + `…(${v.length}字)` : v));
console.log(`===== ${f.split(/[\\/]/).pop()} =====`);
console.log("\n-- ai-title 样例(含字段):"); for (const e of grab["ai-title"]) console.log(brief(e));
console.log("\n-- system/stop_hook_summary 样例:"); for (const e of grab["system/stop_hook_summary"]) console.log(brief(e));
console.log("\n-- system/away_summary 样例:"); for (const e of grab["system/away_summary"]) console.log(brief(e));
console.log("\n-- last-prompt 样例:"); for (const e of grab["last-prompt"]) console.log(brief(e));
console.log("\n-- attachment 样例:"); for (const e of grab.attachment) console.log(brief(e));
console.log("\n-- attributionSkill 分布:", grab.attribution);
console.log("\n-- other-wrapper user 消息样例:"); for (const c of grab.otherWrapper) console.log(c.replace(/\n/g, "\\n").slice(0, 200));
