// 在某 cwd 跑 git log 解析为提交列表（查看页「提交」视图用）。
// 容错优先：非 git 仓库 / git 未装 / 超时 → commits 空数组 + error，绝不抛。
import { GIT_TIMEOUT_MS } from "../shared/config";
import type { CommitFile, CommitLog, CommitsResponse } from "../shared/types";

const SEP = "\x1f"; // unit separator，分隔 pretty 各字段，避免与 subject 内容冲突

/**
 * 拉取最近 N 条非 merge 提交及其 +新增/-删除 行数。
 *
 * git log --numstat --pretty=format:... 的输出形如：
 *   <hash>\x1f<iso>\x1f<author>\x1f<subject>   ← pretty 行（含 SEP）开启一条 commit
 *   <added>\t<deleted>\t<path>                  ← 0..N 行 numstat，二进制文件为 -\t-\t<path>
 *   <hash>\x1f...
 */
export async function getCommits(cwd: string, limit = 200): Promise<CommitsResponse> {
  const safeLimit = Math.min(Math.max(Math.floor(limit) || 200, 1), 1000);
  let stdout: string;
  try {
    stdout = await runGit(cwd, [
      "log",
      "--no-merges",
      `-n`,
      `${safeLimit}`,
      "--numstat",
      `--pretty=format:%H${SEP}%cI${SEP}%an${SEP}%s`,
    ]);
  } catch (e) {
    return { cwd, commits: [], error: friendlyErr(e) };
  }
  return { cwd, commits: parseLog(stdout) };
}

/** 取 cwd 配置的 git 用户名（user.name）；未配置 / git 不可用返回 null。
 *  git config 即使在非 git 目录也能读全局 user.name，故正常会返回全局用户名；都没配则 null。 */
export async function getGitUser(cwd: string): Promise<string | null> {
  try {
    const name = (await runGit(cwd, ["config", "user.name"])).trim();
    return name || null;
  } catch {
    return null;
  }
}

/** 跑 git 子进程，超时或非 0 退出 reject；stdout 文本 resolve。 */
function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = Bun.spawn({
      cmd: ["git", "-C", cwd, ...args],
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`git timed out after ${GIT_TIMEOUT_MS}ms`));
    }, GIT_TIMEOUT_MS);
    void proc.exited
      .then(async (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          const err = await new Response(proc.stderr).text();
          reject(new Error(`git exit ${code}: ${err.trim()}`));
          return;
        }
        resolve(await new Response(proc.stdout).text());
      })
      .catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
  });
}

function parseLog(stdout: string): CommitLog[] {
  const commits: CommitLog[] = [];
  let cur: CommitLog | null = null;
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    if (line.includes(SEP)) {
      if (cur) commits.push(cur);
      const i1 = line.indexOf(SEP);
      const i2 = line.indexOf(SEP, i1 + 1);
      const i3 = line.indexOf(SEP, i2 + 1);
      cur = {
        hash: line.slice(0, i1),
        time: parseIso(line.slice(i1 + 1, i2)),
        author: line.slice(i2 + 1, i3),
        subject: line.slice(i3 + 1),
        files: [],
        added: 0,
        deleted: 0,
      };
    } else if (cur) {
      const f = parseNumstat(line);
      if (f) {
        cur.files.push(f);
        cur.added += f.added;
        cur.deleted += f.deleted;
      }
    }
  }
  if (cur) commits.push(cur);
  return commits;
}

/** numstat 行：<added>\t<deleted>\t<path>；二进制为 -\t-\t<path>（计 0）。 */
function parseNumstat(line: string): CommitFile | null {
  const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
  if (!m) return null;
  const a = m[1] ?? "-";
  const d = m[2] ?? "-";
  const p = m[3] ?? "";
  if (!p) return null;
  return { path: p, added: a === "-" ? 0 : parseInt(a, 10), deleted: d === "-" ? 0 : parseInt(d, 10) };
}

function parseIso(s: string): number {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

/** 把底层错误翻译成查看页可直接展示的中文提示。 */
function friendlyErr(e: unknown): string {
  const s = e instanceof Error ? e.message : String(e);
  if (/not a git repository|fatal:.*repository/i.test(s)) return "当前目录不是 git 仓库";
  if (/ENOENT|spawn|not found|no such file/i.test(s)) return "未找到 git，请确认 git 已安装并在 PATH";
  return s;
}
