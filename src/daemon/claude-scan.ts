// ccusage 式 transcript 扫描：直接读 ~/.claude/projects 下所有 jsonl，按 session 归组，
// 使 daemon 的 token 总量与 `ccusage claude session` 完全一致（不依赖 hook 是否抓到）。
// 逻辑照搬 ccusage rust/crates/ccusage/src/adapter/claude/paths.rs 的 claude_paths + session 归组。
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { getSessionTokenTotal } from "./token-cache";
import type { TokenUsage } from "../shared/types";

export interface ScannedSession {
  /** 编码后的项目目录名（projects/<project>，如 C--Users-ren-Desktop-workspace-ccusage）。 */
  project: string;
  sessionId: string;
  /** 父 transcript 绝对路径（subagents 由 getSessionTokenTotal 自动并入）。 */
  transcriptPath: string;
  /** 父文件 mtime（session 级活跃时间，用于 since 过滤）。 */
  lastActivity: number;
  tokenTotal: TokenUsage;
}

const ZERO: TokenUsage = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };

/** 展开 ~ 为 home。 */
function expandHome(p: string): string {
  return p.replace(/^~/, homedir());
}

/** 解析 Claude 配置目录（含 projects/ 子目录的），等价 ccusage claude_paths。
 *  CLAUDE_CONFIG_DIR（逗号分隔，可指向目录本身或其 projects/）｜$XDG_CONFIG_HOME/claude｜~/.claude。 */
export function claudeProjectsRoots(): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  const addIfHasProjects = (p: string): void => {
    const dir = p.trim();
    if (!dir) return;
    if (existsSync(join(dir, "projects")) && !seen.has(dir)) {
      seen.add(dir);
      roots.push(dir);
    }
  };

  const envDir = process.env.CLAUDE_CONFIG_DIR;
  if (envDir) {
    for (const raw of envDir.split(",")) {
      let p = expandHome(raw.trim());
      if (basename(p) === "projects") p = dirname(p); // 指向 projects/ 本身则取父
      addIfHasProjects(p);
    }
    if (roots.length) return roots;
  }

  const home = homedir();
  const xdg = process.env.XDG_CONFIG_HOME || join(home, ".config");
  addIfHasProjects(join(xdg, "claude"));
  addIfHasProjects(join(home, ".claude"));
  return roots;
}

/** 递归收集 dir 下所有 *.jsonl 绝对路径。 */
function collectJsonl(dir: string, out: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) collectJsonl(p, out);
    else if (name.endsWith(".jsonl")) out.push(p);
  }
}

/** projects/<project>/<session>.jsonl 的相对段（去掉 .jsonl）取 sessionId；project 取 projects 后第一段。
 *  跳过 subagents/ 下的文件（由父 session 的 getSessionTokenTotal 自动并入），跳过非标准嵌套。 */
function parentSessionInfo(
  pathParts: string[],
  projectsIndex: number,
): { project: string; sessionId: string } | null {
  const rel = pathParts.slice(projectsIndex + 1); // projects/ 之后的段
  if (rel.length < 2) return null;
  if (rel.some((seg) => seg === "subagents")) return null; // 子代理，跳过
  if (rel.length !== 2) return null; // 非标准父（如 projects/<proj>/<x>/foo.jsonl），跳过避免误归
  const project = rel[0];
  const sessionId = (rel[1] ?? "").replace(/\.jsonl$/, "");
  if (!project || !sessionId) return null;
  return { project, sessionId };
}

/** 扫描所有 Claude transcript，按 session 归组并算 token（ccusage 口径，含子代理）。
 *  贵的汇总走 getSessionTokenTotal 的 mtime 缓存，遍历只列文件。 */
export function scanSessions(): ScannedSession[] {
  const out: ScannedSession[] = [];
  for (const root of claudeProjectsRoots()) {
    const projectsDir = join(root, "projects");
    const files: string[] = [];
    collectJsonl(projectsDir, files);
    for (const file of files) {
      const parts = file.split(/[/\\]/);
      const projectsIndex = parts.lastIndexOf("projects");
      if (projectsIndex < 0) continue;
      const info = parentSessionInfo(parts, projectsIndex);
      if (!info) continue;
      let mtimeMs: number;
      try {
        mtimeMs = statSync(file).mtimeMs;
      } catch {
        continue;
      }
      const tokenTotal = getSessionTokenTotal(file) ?? ZERO;
      out.push({
        project: info.project,
        sessionId: info.sessionId,
        transcriptPath: file,
        lastActivity: mtimeMs,
        tokenTotal,
      });
    }
  }
  return out;
}
