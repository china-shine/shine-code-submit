// 指标卡:title + value(mono) + sub + 图标块 + 可选 extra(sparkline)。
// 从 TokenWeb App.tsx 搬(155-179),删 change/sparkline 强依赖,extra 由调用方传入 sparkline。
import type { ReactNode } from "react";

export function MetricCard({
  title,
  value,
  sub,
  icon,
  color,
  extra,
}: {
  title: string;
  value: string;
  sub?: string;
  icon: ReactNode;
  color: string;
  extra?: ReactNode;
}) {
  return (
    <div className="bg-card border border-border rounded p-4 flex flex-col gap-3 hover:shadow-md transition-shadow">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{title}</span>
        <span className={`w-8 h-8 rounded-sm flex items-center justify-center ${color}`}>{icon}</span>
      </div>
      <div>
        <div className="text-2xl font-semibold text-foreground font-mono tracking-tight">{value}</div>
        {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
      </div>
      {extra && <div className="flex justify-end -mt-1">{extra}</div>}
    </div>
  );
}
