// Token 消耗趋势 AreaChart(总量/输入/输出/缓存 4 视图)。
// 数据 = bucketByGranularity(flattenSessions(users)):按 session.lastActive 在所选粒度(日/周/月)聚合。
import { useState } from "react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import type { UserAgg } from "../../types";
import { bucketByGranularity, flattenSessions, fmtK, fmtFull, C } from "../../lib/derive";
import type { Granularity } from "../shell/TopBar";
import { chartTheme } from "./chartTheme";

export function TokenTrendChart({ users, dark, granularity }: { users: UserAgg[]; dark: boolean; granularity: Granularity }) {
  const [tokenView, setTokenView] = useState<"total" | "input" | "output" | "cache">("total");
  const data = bucketByGranularity(flattenSessions(users), granularity);
  const { tooltipStyle, tickStyle, gridStroke } = chartTheme(dark);
  const tokenColor = { total: C.total, input: C.input, output: C.output, cache: C.cache }[tokenView];
  const range = data.length > 0 ? `${data[0].date} – ${data[data.length - 1].date}` : "—";
  const granularityLabel = { day: "日", week: "周", month: "月" }[granularity];

  return (
    <div className="col-span-8 bg-card border border-border rounded p-4">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Token 消耗趋势</h3>
          <p className="text-xs text-muted-foreground mt-0.5">{range} · 按{granularityLabel}聚合(会话最后活跃{granularityLabel})</p>
        </div>
        <div className="flex items-center gap-1 bg-muted rounded-sm p-0.5">
          {(["total", "input", "output", "cache"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setTokenView(k)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                tokenView === k ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {{ total: "总量", input: "输入", output: "输出", cache: "缓存" }[k]}
            </button>
          ))}
        </div>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="tokenGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={tokenColor} stopOpacity={0.18} />
              <stop offset="95%" stopColor={tokenColor} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
          <XAxis dataKey="date" tick={tickStyle} tickLine={false} axisLine={false} />
          <YAxis tickFormatter={(v) => fmtK(v)} tick={tickStyle} tickLine={false} axisLine={false} width={42} />
          <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [fmtFull(v) + " tokens", ""]} />
          <Area
            key={`area-${tokenView}`}
            type="monotone"
            dataKey={tokenView}
            stroke={tokenColor}
            strokeWidth={2}
            fill="url(#tokenGrad)"
            dot={false}
            activeDot={{ r: 4 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
