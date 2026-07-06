// 行级 LCS diff（从原 app.js 搬运）。

export interface DiffLine {
  op: "ctx" | "add" | "del";
  text: string;
}

export function computeLineDiff(oldS: unknown, newS: unknown): DiffLine[] {
  const a = String(oldS || "").split("\n");
  const b = String(newS || "").split("\n");
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] =
        a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: "ctx", text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ op: "del", text: a[i]! });
      i++;
    } else {
      out.push({ op: "add", text: b[j]! });
      j++;
    }
  }
  while (i < n) {
    out.push({ op: "del", text: a[i]! });
    i++;
  }
  while (j < m) {
    out.push({ op: "add", text: b[j]! });
    j++;
  }
  return out;
}
