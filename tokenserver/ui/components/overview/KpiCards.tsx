// 6 KPI 卡。总Token/对话次数/代码行 三卡带 sparkline(按日序列);时长卡占位(无 duration)。
// 数据全部来自 globalTotals 现聚合(users 已经过 App 层过滤)。删 change%(无历史)。
import { Coins, Activity, Clock, Code2, Users, Cpu } from "lucide-react";
import type { UserAgg } from "../../types";
import { globalTotals, dailyStats, fmtK, fmtFull, lineTotal, C } from "../../lib/derive";
import { MetricCard } from "../common/MetricCard";
import { MiniSparkline } from "../common/MiniSparkline";

export function KpiCards({ users }: { users: UserAgg[] }) {
  const t = globalTotals(users);
  const ds = dailyStats(users);
  const totalSeries = ds.map((d) => d.total);
  const sessionSeries = ds.map((d) => d.sessions);
  const linesSeries = ds.map((d) => d.lines);

  return (
    <div className="grid grid-cols-6 gap-4">
      <MetricCard
        title="总 Token 消耗"
        value={fmtK(t.rawTotal)}
        sub={`输入 ${fmtK(t.token.input)} · 输出 ${fmtK(t.token.output)}`}
        icon={<Coins className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />}
        color="bg-indigo-50 dark:bg-indigo-900/30"
        extra={<MiniSparkline data={totalSeries} color={C.total} />}
      />
      <MetricCard
        title="对话次数"
        value={fmtFull(t.sessions)}
        sub="按会话最后活跃日聚合"
        icon={<Activity className="w-4 h-4 text-blue-600 dark:text-blue-400" />}
        color="bg-blue-50 dark:bg-blue-900/30"
        extra={<MiniSparkline data={sessionSeries} color={C.input} />}
      />
      <MetricCard
        title="对话总时长"
        value="—"
        sub="需 daemon 上报时长"
        icon={<Clock className="w-4 h-4 text-orange-600 dark:text-orange-400" />}
        color="bg-orange-50 dark:bg-orange-900/30"
      />
      <MetricCard
        title="生成代码行数"
        value={fmtFull(lineTotal(t.lines))}
        sub={`新增 ${fmtK(t.lines.added)} · 修改 ${fmtK(t.lines.modified)} · 删除 ${fmtK(t.lines.deleted)}`}
        icon={<Code2 className="w-4 h-4 text-teal-600 dark:text-teal-400" />}
        color="bg-teal-50 dark:bg-teal-900/30"
        extra={<MiniSparkline data={linesSeries} color={C.code} />}
      />
      <MetricCard
        title="活跃成员"
        value={fmtFull(t.members)}
        sub="当前筛选范围内"
        icon={<Users className="w-4 h-4 text-violet-600 dark:text-violet-400" />}
        color="bg-violet-50 dark:bg-violet-900/30"
      />
      <MetricCard
        title="活跃项目"
        value={fmtFull(t.projects)}
        sub="跨用户项目数"
        icon={<Cpu className="w-4 h-4 text-cyan-600 dark:text-cyan-400" />}
        color="bg-cyan-50 dark:bg-cyan-900/30"
      />
    </div>
  );
}
