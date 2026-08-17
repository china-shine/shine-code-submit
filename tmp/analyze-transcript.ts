// transcript 结构分析:统计 type/role/block/标志位分布,找"关键内容"的标识规律
const files = process.argv.slice(2);
for (const f of files) {
  const raw = await Bun.file(f).text();
  const lines = raw.split("\n").filter((l) => l.trim());
  const t = {
    type: {} as Record<string, number>,
    subtype: {} as Record<string, number>,
    flags: {} as Record<string, number>,
    role: {} as Record<string, number>,
    blocks: {} as Record<string, number>,
    tools: {} as Record<string, number>,
    userTextKinds: {} as Record<string, number>,
    userTextSamples: [] as string[],
    assistantTextLens: [] as number[],
    topLevelKeys: {} as Record<string, number>,
  };
  for (const line of lines) {
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    for (const k of Object.keys(ev)) t.topLevelKeys[k] = (t.topLevelKeys[k] ?? 0) + 1;
    t.type[ev.type ?? "(none)"] = (t.type[ev.type ?? "(none)"] ?? 0) + 1;
    if (ev.subtype) t.subtype[`${ev.type}/${ev.subtype}`] = (t.subtype[`${ev.type}/${ev.subtype}`] ?? 0) + 1;
    for (const flag of ["isSidechain", "isMeta", "isApiErrorMessage", "isCompactSummary", "isVisibleInTranscriptOnly"]) {
      if (ev[flag]) t.flags[flag] = (t.flags[flag] ?? 0) + 1;
    }
    const role = ev.message?.role;
    if (role) t.role[role] = (t.role[role] ?? 0) + 1;
    const content = ev.message?.content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (!b?.type) continue;
        t.blocks[b.type] = (t.blocks[b.type] ?? 0) + 1;
        if (b.type === "tool_use") {
          t.tools[b.name ?? "unknown"] = (t.tools[b.name ?? "unknown"] ?? 0) + 1;
        }
      }
    } else if (typeof content === "string" && role === "user") {
      const c = content.trim();
      let kind = "plain-string";
      if (c.startsWith("<")) {
        kind = /^<(command-name|local-command-stdout|system-reminder|task-notification|bash|user-memory|artifact)/.test(c)
          ? "cmd/system-wrapper"
          : "other-wrapper";
      }
      t.userTextKinds[kind] = (t.userTextKinds[kind] ?? 0) + 1;
      if (kind === "plain-string" && !ev.isMeta && !ev.isSidechain && t.userTextSamples.length < 3) {
        t.userTextSamples.push(c.slice(0, 80).replace(/\n/g, " "));
      }
    }
    if (role === "assistant" && Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === "text" && typeof b.text === "string") t.assistantTextLens.push(b.text.length);
      }
    }
  }
  const pct = (n: number) => `${n} (${((n / lines.length) * 100).toFixed(1)}%)`;
  console.log(`\n===== ${f.split(/[\\/]/).pop()} (${(raw.length / 1e6).toFixed(1)}MB, ${lines.length} lines) =====`);
  console.log("type:", t.type);
  console.log("subtype:", Object.keys(t.subtype).length ? t.subtype : "(无)");
  console.log("role:", t.role, "| flags:", t.flags);
  console.log("blocks:", t.blocks);
  console.log("tools:", Object.fromEntries(Object.entries(t.tools).sort((a, b) => b[1] - a[1]).slice(0, 15)));
  console.log("user字符串内容分类:", t.userTextKinds, "| 样例:", t.userTextSamples);
  const at = t.assistantTextLens.filter((l) => l > 10);
  console.log(`assistant text blocks(>10字): ${at.length} 个, 中位长度 ${at.length ? at.sort((a, b) => a - b)[Math.floor(at.length / 2)] : 0}, >300字 ${at.filter((l) => l > 300).length} 个`);
  console.log("topLevelKeys:", Object.fromEntries(Object.entries(t.topLevelKeys).sort((a, b) => b[1] - a[1])));
}
