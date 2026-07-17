// recharts 共享主题:tooltip/tick/grid 按 dark 切换。从 TokenWeb App.tsx 三处重复内联抽离。
export function chartTheme(dark: boolean) {
  return {
    tooltipStyle: {
      background: dark ? "#1E2235" : "#fff",
      border: `1px solid ${dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.08)"}`,
      borderRadius: 8,
      fontSize: 12,
    },
    tickStyle: { fontSize: 11, fill: dark ? "#6B7280" : "#9CA3AF" },
    gridStroke: dark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.05)",
  };
}
