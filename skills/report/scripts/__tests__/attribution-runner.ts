/** attribution.test 的子进程 runner:toZenSession 的归属日计算。
 *  所有本地时间运算(epoch→date/HHMM)都在 runner 侧(+8 真本地)做——主测试进程 bun test 是
 *  TZ=UTC、差 8h(bun-test-tz-utc-runner-trap);runner 只输出转换后的字符串,主进程做相对断言。 */
if (!process.env.LOCALAPPDATA) process.env.LOCALAPPDATA = process.cwd(); // 兜底隔离,绝不落真实 DATA_DIR

const shared = await import("../lib/shared");
const { toZenSession } = await import("../lib/transcript");

/** 本地时刻 h:m(可往前推 minusDays 天)的 epoch ms。 */
function localAt(h: number, m: number, minusDays = 0): number {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  d.setDate(d.getDate() - minusDays);
  return d.getTime();
}

// 场景基准:今天 10:00 / 昨天 18:00(全部日期运算在 runner 本地时区完成)
const today10 = localAt(10, 0);
const yesterday18 = localAt(18, 0, 1);

// 跨天会话:activeMs=15h(起点=昨天 19:00),lastActive=今早 10:00 → 归属日应=今天(整体归最后活跃日,已拍板)
const crossDay = toZenSession(
  { sessionId: "s32", cwd: "C:/proj", activeMs: 15 * 3600e3, lastActive: today10, tokenTotal: {}, linesTotal: {}, title: "跨天会话" },
  "main",
);
// 独立昨天会话:activeMs=60min,lastActive=昨天 18:00 → 归属日应=昨天(本来就分得开)
const standalone = toZenSession(
  { sessionId: "s30", cwd: "C:/proj", activeMs: 60 * 60e3, lastActive: yesterday18, tokenTotal: {}, linesTotal: {}, title: "昨天独立会话" },
  "main",
);

console.log(JSON.stringify({
  today: shared.localDateISO(today10),
  yesterday: shared.localDateISO(yesterday18),
  crossDay: { date: crossDay.date, start: crossDay.start, end: crossDay.end, activeMinutes: crossDay.activeMinutes },
  standalone: { date: standalone.date, start: standalone.start, end: standalone.end, activeMinutes: standalone.activeMinutes },
}));
