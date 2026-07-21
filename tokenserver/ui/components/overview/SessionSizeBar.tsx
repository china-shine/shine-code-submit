// 会话规模分布 BarChart(按总 Token 分桶)。数据 = stats.sizeBuckets(后端聚合)。
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { C } from "../../lib/derive";
import { chartTheme } from "./chartTheme";

export function SessionSizeBar({
  sizeBuckets,
  dark,
}: {
  sizeBuckets: Array<{ range: string; count: number }>;
  dark: boolean;
}) {
  const data = sizeBuckets;
  const { tooltipStyle, tickStyle, gridStroke } = chartTheme(dark);

  return (
    <div className="col-span-4 bg-card border border-border rounded p-4">
      <h3 className="text-sm font-semibold text-foreground">会话规模分布</h3>
      <p className="text-xs text-muted-foreground mb-3 mt-0.5">按总 Token 分桶(无时长数据,以规模替代)</p>
      <ResponsiveContainer width="100%" height={180}>
        <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -12 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
          <XAxis dataKey="range" tick={{ fontSize: 10, fill: dark ? "#6B7280" : "#9CA3AF" }} tickLine={false} axisLine={false} />
          <YAxis tick={tickStyle} tickLine={false} axisLine={false} allowDecimals={false} />
          <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [v + " 个", "会话数"]} />
          <Bar dataKey="count" fill={C.dur} radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
