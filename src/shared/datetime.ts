/** 日期/项目编码 helpers。main.ts(hook) import 此处;
 *  zentao.ts 因「零 npm 依赖、可被 bun 直跑」约束内联同款(改动需两边同步,见 zentao.ts:30/93/98)。 */

/** 项目目录编码:非字母数字→"-",对齐 Claude Code ~/.claude/projects/<编码>(空格/标点/中文均→-)。 */
export function encodeProject(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

/** 本地日期 YYYY-MM-DD(不用 toISOString,那是 UTC)。 */
export function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 任意时间戳的本地日期 YYYY-MM-DD(0/非法=今天)。 */
export function dateISO(ts: number): string {
  const d = new Date(Number.isFinite(ts) && ts > 0 ? ts : Date.now());
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
