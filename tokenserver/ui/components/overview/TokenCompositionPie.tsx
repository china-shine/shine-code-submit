// Token 构成环形饼图(输入/输出/缓存) + 中心总数 + 图例占比。数据 = globalTotals 四件套求和。
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from "recharts";
import type { UserAgg } from "../../types";
import { globalTotals, fmtK, C } from "../../lib/derive";
import { chartTheme } from "./chartTheme";

export function TokenCompositionPie({ users, dark }: { users: UserAgg[]; dark: boolean }) {
  const t = globalTotals(users);
  const pieData = [
    { name: "输入 Token", value: t.token.input, color: C.input },
    { name: "输出 Token", value: t.token.output, color: C.output },
    { name: "缓存 Token", value: t.token.cacheCreation + t.token.cacheRead, color: C.cache },
  ];
  const pieTotal = pieData.reduce((s, d) => s + d.value, 0);
  const { tooltipStyle } = chartTheme(dark);

  return (
    <div className="col-span-4 bg-card border border-border rounded p-4">
      <h3 className="text-sm font-semibold text-foreground mb-4">Token 构成</h3>
      <div className="relative">
        <ResponsiveContainer width="100%" height={160}>
          <PieChart>
            <Pie data={pieData} cx="50%" cy="50%" innerRadius={52} outerRadius={72} dataKey="value" paddingAngle={2}>
              {pieData.map((d, i) => (
                <Cell key={i} fill={d.color} strokeWidth={0} />
              ))}
            </Pie>
            <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [fmtK(v) + " tokens", ""]} />
          </PieChart>
        </ResponsiveContainer>
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <div className="text-lg font-bold font-mono text-foreground">{fmtK(pieTotal)}</div>
          <div className="text-xs text-muted-foreground">总 Token</div>
        </div>
      </div>
      <div className="space-y-2 mt-3">
        {pieData.map((d) => (
          <div key={d.name} className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full" style={{ background: d.color }} />
              <span className="text-xs text-muted-foreground">{d.name}</span>
            </div>
            <div className="text-right">
              <span className="text-xs font-medium font-mono text-foreground">{fmtK(d.value)}</span>
              <span className="text-xs text-muted-foreground ml-1.5">
                {pieTotal > 0 ? ((d.value / pieTotal) * 100).toFixed(1) : "0"}%
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
