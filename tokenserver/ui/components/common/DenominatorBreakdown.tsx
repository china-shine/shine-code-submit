// AI 占比「分母构成」:按钮 + 弹窗。按项目(cwd)+ 按 AI 覆盖(aiAdded=0 vs >0)拆 git_changes 分母,
// 让用户/领导看清分母里有多少真实 AI 项目、多少是无 transcript 覆盖的 commit(解释整体占比偏低)。
import { useEffect, useState, type ReactNode } from "react";
import { Modal } from "./Modal";
import { fmtFull, fmtPct, displayProjectName } from "../../lib/derive";
import { Database, Bot, FolderGit2, CheckCircle2, AlertCircle } from "lucide-react";

interface Breakdown {
  byCwd: { cwd: string; denom: number; ai: number; commits: number }[];
  byAi: { bucket: "ai" | "no-ai"; denom: number; ai: number; commits: number }[];
  total: { denom: number; ai: number; commits: number };
}

const ratio = (n: number, d: number) => (d > 0 ? n / d : 0);

function Bar({ value, className }: { value: number; className: string }) {
  return (
    <div className="relative h-2 w-full rounded-full bg-muted overflow-hidden">
      <div className={`absolute inset-y-0 left-0 rounded-full ${className}`} style={{ width: `${Math.min(100, value * 100)}%` }} />
    </div>
  );
}

export function DenominatorBreakdownButton({ startDate, endDate, members, member }: {
  startDate: string;
  endDate: string;
  members?: string[];
  member?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="查看分母构成"
        className="text-[10px] px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:bg-accent hover:text-foreground whitespace-nowrap"
      >
        分母
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="AI 占比分母构成">
        <BreakdownBody startDate={startDate} endDate={endDate} members={members} member={member} />
      </Modal>
    </>
  );
}

function BreakdownBody({ startDate, endDate, members, member }: { startDate: string; endDate: string; members?: string[]; member?: string }) {
  const [data, setData] = useState<Breakdown | null>(null);
  useEffect(() => {
    const params = new URLSearchParams({ start: startDate, end: endDate });
    if (member) params.set("member", member);
    else if (members && members.length > 0) params.set("members", members.join(","));
    setData(null);
    fetch(`/api/denominator-breakdown?${params.toString()}`)
      .then((r) => r.json())
      .then((d: Breakdown) => setData(d))
      .catch(() => setData(null));
  }, [startDate, endDate, members, member]);
  if (!data) return <div className="text-muted-foreground text-sm py-12 text-center">加载中…</div>;

  const total = data.total;
  const aiRow = data.byAi.find((r) => r.bucket === "ai");
  const noAiRow = data.byAi.find((r) => r.bucket === "no-ai");
  const aiDenom = aiRow?.denom ?? 0;
  const noAiDenom = noAiRow?.denom ?? 0;

  return (
    <div className="space-y-6">
      {/* 顶部总览 stat */}
      <div className="grid grid-cols-4 gap-3">
        <StatCell label="总分母" value={fmtFull(total.denom)} sub="行" icon={<Database className="w-4 h-4" />} tint="bg-slate-100 dark:bg-slate-800 text-slate-500" />
        <StatCell label="AI 代码" value={fmtFull(total.ai)} sub="行" icon={<Bot className="w-4 h-4" />} tint="bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 dark:text-emerald-400" valueClass="text-emerald-600 dark:text-emerald-400" />
        <StatCell label="整体占比" value={fmtPct(ratio(total.ai, total.denom))} icon={<Bot className="w-4 h-4" />} tint="bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 dark:text-emerald-400" valueClass="text-emerald-600 dark:text-emerald-400" highlight />
        <StatCell label="commit" value={fmtFull(total.commits)} icon={<Database className="w-4 h-4" />} tint="bg-slate-100 dark:bg-slate-800 text-slate-500" />
      </div>

      {/* 按项目 */}
      <Section title="按项目" icon={<FolderGit2 className="w-4 h-4" />} hint={`${data.byCwd.length} 个项目`}>
        <table className="w-full table-fixed">
          <colgroup>
            <col className="w-[34%]" />
            <col />
            <col />
            <col className="w-[26%]" />
            <col />
          </colgroup>
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-muted-foreground border-b border-border">
              <th className="text-left py-2 pr-3 font-medium">项目</th>
              <th className="text-right py-2 pr-3 font-medium">分母行</th>
              <th className="text-right py-2 pr-4 font-medium">AI 行</th>
              <th className="text-right py-2 pr-3 font-medium">占比</th>
              <th className="text-right py-2 font-medium">commit</th>
            </tr>
          </thead>
          <tbody>
            {data.byCwd.map((r, i) => (
              <tr key={r.cwd} className={`border-b border-border/40 ${i % 2 ? "bg-muted/20" : ""} hover:bg-accent/40 transition-colors`}>
                <td className="py-2 pr-3 truncate" title={r.cwd}>{displayProjectName(undefined, r.cwd)}</td>
                <td className="py-2 pr-3 text-right font-mono tabular-nums text-muted-foreground">{fmtFull(r.denom)}</td>
                <td className="py-2 pr-4 text-right font-mono tabular-nums text-emerald-600 dark:text-emerald-400">{fmtFull(r.ai)}</td>
                <td className="py-2 pr-3">
                  <div className="flex items-center gap-2">
                    <span className="font-mono tabular-nums w-12 text-right">{fmtPct(ratio(r.ai, r.denom))}</span>
                    <Bar value={ratio(r.ai, r.denom)} className="bg-emerald-500" />
                  </div>
                </td>
                <td className="py-2 text-right font-mono tabular-nums text-muted-foreground">{r.commits}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {/* 按 AI 覆盖 */}
      <Section title="按 AI 覆盖" icon={<Bot className="w-4 h-4" />}>
        <div className="grid grid-cols-2 gap-3">
          <CoverageCard
            ok
            label="有 AI 数据"
            desc="commit 的 aiAdded > 0(transcript 已覆盖)"
            denom={aiDenom}
            commits={aiRow?.commits ?? 0}
            share={ratio(aiDenom, total.denom)}
          />
          <CoverageCard
            ok={false}
            label="无 AI 数据"
            desc="aiAdded = 0(早期版本前 / 别机器,未装 transcript)"
            denom={noAiDenom}
            commits={noAiRow?.commits ?? 0}
            share={ratio(noAiDenom, total.denom)}
          />
        </div>
        <div className="mt-3 flex items-start gap-2 text-muted-foreground text-xs">
          <AlertCircle className="w-3.5 h-3.5 mt-px shrink-0 text-amber-500" />
          <span>「无 AI 数据」的分母拉低整体占比——这是占比偏低的来源,不代表这些代码不是 AI 写的。</span>
        </div>
      </Section>
    </div>
  );
}

function StatCell({ label, value, sub, icon, tint, valueClass, highlight }: { label: string; value: string; sub?: string; icon: ReactNode; tint: string; valueClass?: string; highlight?: boolean }) {
  return (
    <div className={`rounded-lg p-3 border ${highlight ? "bg-emerald-50/60 dark:bg-emerald-900/20 border-emerald-200/70 dark:border-emerald-900/40" : "bg-muted/30 border-border/60"}`}>
      <div className="flex items-center gap-2.5">
        <span className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${tint}`}>{icon}</span>
        <div className="min-w-0">
          <div className="text-muted-foreground text-[11px]">{label}</div>
          <div className="flex items-baseline gap-0.5">
            <span className={`text-xl font-semibold font-mono leading-tight truncate ${valueClass ?? "text-foreground"}`}>{value}</span>
            {sub && <span className="text-muted-foreground text-[11px]">{sub}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ title, icon, hint, children }: { title: string; icon: ReactNode; hint?: string; children: ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-2.5">
        <span className="text-muted-foreground">{icon}</span>
        <span className="text-sm font-semibold text-foreground">{title}</span>
        {hint && <span className="text-muted-foreground text-xs ml-auto">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function CoverageCard({ ok, label, desc, denom, commits, share }: { ok: boolean; label: string; desc: string; denom: number; commits: number; share: number }) {
  const Icon = ok ? CheckCircle2 : AlertCircle;
  const tint = ok ? "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 dark:text-emerald-400" : "bg-amber-100 dark:bg-amber-900/40 text-amber-600 dark:text-amber-400";
  const bar = ok ? "bg-emerald-500" : "bg-amber-500";
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center gap-2.5">
        <span className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${tint}`}><Icon className="w-4 h-4" /></span>
        <div className="min-w-0">
          <div className="font-medium text-foreground">{label}</div>
          <div className="text-muted-foreground text-[11px]">{commits} commit</div>
        </div>
        <span className="ml-auto font-mono text-foreground text-lg font-semibold">{fmtFull(denom)}</span>
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <Bar value={share} className={bar} />
        <span className="font-mono text-muted-foreground w-11 text-right">{fmtPct(share)}</span>
      </div>
      <div className="mt-1.5 text-muted-foreground text-[11px]">{desc}</div>
    </div>
  );
}
