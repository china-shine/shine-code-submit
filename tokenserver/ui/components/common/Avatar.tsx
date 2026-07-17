// 头像:首字母 + 按 charCode 分配 indigo/violet/blue/teal/orange/rose/cyan 背景。
// 从 TokenWeb App.tsx 原样搬(138-143),加空名兜底(gitUser 可能为空)。
export function Avatar({ name, size = "sm" }: { name: string; size?: "sm" | "md" | "lg" }) {
  const colors = ["bg-indigo-500", "bg-violet-500", "bg-blue-500", "bg-teal-500", "bg-orange-500", "bg-rose-500", "bg-cyan-500"];
  const ch = name?.[0] ?? "?";
  const color = colors[ch.charCodeAt(0) % colors.length];
  const sz = size === "sm" ? "w-7 h-7 text-xs" : size === "md" ? "w-9 h-9 text-sm" : "w-11 h-11 text-base";
  return (
    <div className={`${sz} ${color} rounded-full flex items-center justify-center text-white font-semibold flex-shrink-0`}>
      {ch}
    </div>
  );
}
