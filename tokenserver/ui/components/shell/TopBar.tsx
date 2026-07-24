// 顶栏:时间范围(开始/结束日期) + 成员多选筛选 + 派生范围文本 + 刷新。
// 趋势图固定按日聚合(日/周/月切换已移除)。三控件全部接真数据(由 App 层过滤后下传)。
import { useEffect, useRef, useState } from "react";
import { DayPicker, type Matcher } from "react-day-picker";
import { zhCN } from "date-fns/locale";
import { ChevronDown, RefreshCw, Check, Calendar } from "lucide-react";
import { Avatar } from "../common/Avatar";
import { toDateInput } from "../../lib/util";

export type Granularity = "day" | "week" | "month";

const DATE_INPUT_CLS =
  "px-2 py-1.5 rounded-sm border border-border text-xs text-foreground bg-card cursor-pointer hover:bg-muted transition-colors";

/** 日期字段:YYYY-MM-DD 文本 + 日历图标;点击弹 react-day-picker 日历(zhCN 中文、周一起,用官方默认样式),选完回填。 */
function DateField({ value, onChange, placeholder, disabled }: { value: string; onChange: (s: string) => void; placeholder: string; disabled?: Matcher }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const selected = value ? new Date(value + "T00:00:00") : undefined;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`${DATE_INPUT_CLS} w-32 flex items-center justify-between gap-1`}
      >
        <span className={`truncate font-mono ${value ? "text-foreground" : "text-muted-foreground"}`}>{value || placeholder}</span>
        <Calendar className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 z-50 bg-card border border-border rounded-sm shadow-lg">
          <DayPicker
            mode="single"
            locale={zhCN}
            weekStartsOn={1}
            navLayout="around"
            selected={selected}
            disabled={disabled}
            defaultMonth={selected ?? new Date()}
            onSelect={(d) => {
              if (d) {
                onChange(toDateInput(d.getTime()));
                setOpen(false);
              }
            }}
            formatters={{
              formatCaption: (m) => `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}`,
            }}
          />
        </div>
      )}
    </div>
  );
}

export function TopBar({
  startDate,
  endDate,
  onStart,
  onEnd,
  members,
  selectedMembers,
  onToggleMember,
  onClearMembers,
  rangeText,
  onRefresh,
}: {
  startDate: string;
  endDate: string;
  onStart: (s: string) => void;
  onEnd: (s: string) => void;
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
      {/* 时间范围:开始 / 结束日期(空=不限)。开始日历禁晚于结束日的、结束日历禁早于开始日的,保证 开始<=结束。 */}
      <div className="flex items-center gap-1.5">
        <DateField value={startDate} onChange={onStart} placeholder="开始日期" disabled={endDate ? { after: new Date(endDate + "T00:00:00") } : undefined} />
        <span className="text-xs text-muted-foreground">—</span>
        <DateField value={endDate} onChange={onEnd} placeholder="结束日期" disabled={startDate ? { before: new Date(startDate + "T00:00:00") } : undefined} />
      </div>

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
