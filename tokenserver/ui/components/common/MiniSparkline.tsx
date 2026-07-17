// 迷你趋势线(inline SVG,不需 recharts)。从 TokenWeb App.tsx 原样搬(145-153),加数据不足保护。
export function MiniSparkline({ data, color }: { data: number[]; color: string }) {
  if (!data || data.length < 2) return null;
  const max = Math.max(...data, 1);
  const points = data
    .map((v, i) => `${(i / (data.length - 1)) * 100},${100 - (v / max) * 80}`)
    .join(" ");
  return (
    <svg viewBox="0 0 100 40" className="w-16 h-8" preserveAspectRatio="none">
      <polyline fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" points={points} />
    </svg>
  );
}
