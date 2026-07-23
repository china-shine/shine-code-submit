// transcript 路径/类型工具:claudeProjectsRoots/collectJsonl/ScannedSession。
// 原 scanSessions 系列(轮询扫描 + getSessionInfo mtime 缓存)已删(P3),
// 改由 watcher + transcript-consumer + SQLite 数据中枢维护。本文件只留路径/类型工具,供 watcher/consumer/aggregate 复用。
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { TokenUsage } from "../shared/types";

export interface ScannedSession {
  /** 编码后的项目目录名(projects/<project>,如 C--Users-ren-Desktop-workspace-ccusage)。 */
  project: string;
  sessionId: string;
  /** 父 transcript 绝对路径(subagents 由消费者归并)。 */
  transcriptPath: string;
  /** 父文件 mtime(session 级活跃时间,用于 since 过滤)。 */
  lastActivity: number;
  tokenTotal: TokenUsage;
  /** gap-aware 活跃时长(ms):父+子代理合并,messageId 去重,1h gap 截断。 */
  activeMs: number;
  /** 首条 user 消息(会话标题);读不到为 null。 */
  title: string | null;
  /** 真实 cwd(从 transcript 首条 cwd 字段读,无编码损失);读不到为 null,消费方回退解码目录名。 */
  cwd: string | null;
}

/** 展开 ~ 为 home。 */
function expandHome(p: string): string {
  return p.replace(/^~/, homedir());
}

/** 解析 Claude 配置目录(含 projects/ 子目录的),等价 ccusage claude_paths。
 *  CLAUDE_CONFIG_DIR(逗号分隔,可指向目录本身或其 projects/)|$XDG_CONFIG_HOME/claude|~/.claude。 */
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
export function collectJsonl(dir: string, out: string[]): void {
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
