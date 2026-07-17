// 顶栏:粒度(日/周/月) + 时间范围(预设下拉) + 成员多选筛选 + 派生范围文本 + 刷新。
// 三控件全部接真数据(由 App 层过滤后下传)。从 TokenWeb TopBar(727-784) 演化,把占位控件做成真功能。
import { useState } from "react";
import { ChevronDown, RefreshCw, Check } from "lucide-react";
import { Avatar } from "../common/Avatar";

export type Granularity = "day" | "week" | "month";
export type RangeKey = "7d" | "15d" | "30d" | "all";

const RANGES: { key: RangeKey; label: string }[] = [
  { key: "7d", label: "最近 7 天" },
  { key: "15d", label: "最近 15 天" },
  { key: "30d", label: "最近 30 天" },
  { key: "all", label: "全部" },
];

export function TopBar({
  granularity,
  onGranularity,
  range,
  onRange,
  members,
  selectedMembers,
  onToggleMember,
  onClearMembers,
  rangeText,
  onRefresh,
}: {
  granularity: Granularity;
  onGranularity: (g: Granularity) => void;
  range: RangeKey;
  onRange: (r: RangeKey) => void;
  members: string[];
  selectedMembers: string[];
  onToggleMember: (g: string) => void;
  onClearMembers: () => void;
  rangeText: string;
  onRefresh: () => void;
}) {
  const [memberOpen, setMemberOpen] = useState(false);

  return (
    <header className="h-14 bg-card border-b border-border flex items-center px-5 gap-3 sticky top-0 z-30 flex-shrink-0">
      {/* 粒度 */}
      <div className="flex items-center gap-0.5 bg-muted rounded-sm p-0.5">
        {(["day", "week", "month"] as const).map((g) => (
          <button
            key={g}
            onClick={() => onGranularity(g)}
            className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
              granularity === g ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {{ day: "日", week: "周", month: "月" }[g]}
          </button>
        ))}
      </div>

      {/* 时间范围 */}
      <select
        value={range}
        onChange={(e) => onRange(e.target.value as RangeKey)}
        className="appearance-none px-3 py-1.5 pr-7 rounded-sm border border-border text-xs text-foreground bg-card cursor-pointer hover:bg-muted transition-colors"
      >
        {RANGES.map((r) => (
          <option key={r.key} value={r.key}>
            {r.label}
          </option>
        ))}
      </select>

      {/* 成员多选 */}
      <div className="relative">
        <button
          onClick={() => setMemberOpen((o) => !o)}
          className={`flex items-center gap-1 px-2.5 py-1.5 rounded-sm border text-xs transition-colors ${
            selectedMembers.length > 0 ? "border-primary bg-primary/5 text-primary" : "border-border text-muted-foreground hover:bg-muted"
          }`}
        >
          {selectedMembers.length > 0 ? `已选 ${selectedMembers.length} 人` : "成员"} <ChevronDown className="w-3 h-3" />
        </button>
        {memberOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setMemberOpen(false)} />
            <div className="absolute top-full left-0 mt-1 w-48 bg-card border border-border rounded-sm shadow-lg z-50 max-h-80 overflow-y-auto">
              <button
                onClick={() => {
                  onClearMembers();
                }}
                className={`w-full text-left px-3 py-1.5 text-xs hover:bg-muted flex items-center gap-2 ${
                  selectedMembers.length === 0 ? "text-primary font-medium" : "text-foreground"
                }`}
              >
                <span className={`w-3 h-3 rounded-sm border flex-shrink-0 ${selectedMembers.length === 0 ? "bg-primary border-primary" : "border-border"}`} />
                全部成员
              </button>
              {members.map((g) => {
                const checked = selectedMembers.includes(g);
                return (
                  <button
                    key={g || "?"}
                    onClick={() => onToggleMember(g)}
                    className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted flex items-center gap-2"
                  >
                    <span className={`w-3 h-3 rounded-sm border flex-shrink-0 flex items-center justify-center ${checked ? "bg-primary border-primary" : "border-border"}`}>
                      {checked && <Check className="w-2.5 h-2.5 text-white" />}
                    </span>
                    <Avatar name={g || "?"} size="sm" />
                    <span className={checked ? "text-primary font-medium" : "text-foreground"}>{g || "未知"}</span>
                  </button>
                );
              })}
              {selectedMembers.length > 0 && (
                <div className="border-t border-border px-3 py-1.5 flex justify-end">
                  <button onClick={onClearMembers} className="text-xs text-muted-foreground hover:text-foreground transition-colors">
                    清除
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <span className="text-xs text-muted-foreground font-mono whitespace-nowrap">{rangeText}</span>

      <button
        onClick={onRefresh}
        className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-sm border border-border text-xs text-muted-foreground hover:bg-muted transition-colors"
      >
        <RefreshCw className="w-3.5 h-3.5" /> 刷新
      </button>
    </header>
  );
}
