// transcript 文件监听:fs.watch 监听 ~/.claude/projects,变化/新增 → 只标 SQLite dirty(轻量,不读文件内容)。
// Win/mac 用 recursive 单 watcher 覆盖整树;Linux 不支持 recursive,遍历每个 project 目录分别 watch + 新目录补挂。
// 事件 debounce 250ms 合并高频微事件。watcher 失败不影响 daemon(消费者 5min fullScanBackstop 兜底)。
// 首次 baseline 发现由 consumer 的 fullScanBackstop 负责,watcher 只监听启动后的变化。
import { watch, readdirSync, statSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { claudeProjectsRoots } from "./claude-scan";
import { classifyTranscriptPath, type ClassifiedTranscriptPath } from "./transcript";
import type { Store } from "./store";
import { Logger } from "./logger";

const DEBOUNCE_MS = 250;
const REWATCH_DELAYS = [500, 1000, 2000, 5000, 10_000];

// fs.watch recursive 仅 Win/mac 原生支持;Linux 不支持(需遍历目录分别 watch)
const RECURSIVE_SUPPORTED = process.platform === "win32" || process.platform === "darwin";

export class TranscriptWatcher {
  private log = new Logger("transcript-watcher");
  private watchers = new Map<string, FSWatcher>(); // dir → watcher
  private debounce = new Map<string, ReturnType<typeof setTimeout>>(); // path → timer
  private retryCount = 0;
  private stopped = true;

  constructor(private store: Store) {}

  start(): void {
    this.stopped = false;
    this.retryCount = 0;
    this.attachWatches();
  }

  stop(): void {
    this.stopped = true;
    for (const [, t] of this.debounce) clearTimeout(t);
    this.debounce.clear();
    for (const [, w] of this.watchers) {
      try { w.close(); } catch { /* ignore */ }
    }
    this.watchers.clear();
  }

  private attachWatches(): void {
    try {
      for (const root of claudeProjectsRoots()) {
        const projectsDir = join(root, "projects");
        this.addWatch(projectsDir);
        if (!RECURSIVE_SUPPORTED) {
          // Linux:遍历每个 project 目录分别 watch(非 recursive 必需)
          for (const proj of listDirs(projectsDir)) this.addWatch(proj);
        }
      }
      this.retryCount = 0;
    } catch (e) {
      this.handleWatchError("attachWatches", e);
    }
  }

  private addWatch(dir: string): void {
    if (this.stopped || this.watchers.has(dir)) return;
    try {
      const w = watch(dir, { recursive: RECURSIVE_SUPPORTED }, (_event, filename) => {
        if (!filename) return;
        this.onEvent(join(dir, filename));
      });
      w.on("error", (e) => this.handleWatchError(dir, e));
      this.watchers.set(dir, w);
    } catch (e) {
      this.handleWatchError(dir, e);
    }
  }

  private onEvent(absPath: string): void {
    if (absPath.endsWith(".jsonl")) {
      const info = classifyTranscriptPath(absPath);
      if (info) this.scheduleMarkDirty(absPath, info);
      return;
    }
    // 非 jsonl:可能是新目录。Linux 非 recursive 需补 watch(Win/mac recursive 单 watcher 已覆盖整树)
    if (!RECURSIVE_SUPPORTED) {
      try {
        if (statSync(absPath).isDirectory()) this.addWatch(absPath);
      } catch { /* 不是目录或已不存在 */ }
    }
  }

  private scheduleMarkDirty(absPath: string, info: ClassifiedTranscriptPath): void {
    const existing = this.debounce.get(absPath);
    if (existing) clearTimeout(existing);
    this.debounce.set(
      absPath,
      setTimeout(() => {
        this.debounce.delete(absPath);
        if (this.stopped) return;
        try {
          this.store.markFileDirtyOrInsert({
            path: absPath,
            sessionId: info.sessionId,
            projectId: info.projectId,
            parentPath: info.parentPath,
            isSubagent: info.kind === "subagent",
          });
        } catch (e) {
          this.log.info(`markDirty ${absPath} failed`, e);
        }
      }, DEBOUNCE_MS),
    );
  }

  private handleWatchError(ctx: string, e: unknown): void {
    this.log.warn(`watch error (${ctx})`, e);
    if (this.stopped) return;
    this.retryCount++;
    if (this.retryCount > 5) {
      this.log.warn("watcher failed 5+ times, giving up (consumer 5min fullScanBackstop covers)");
      return;
    }
    const delay = REWATCH_DELAYS[Math.min(this.retryCount - 1, REWATCH_DELAYS.length - 1)];
    setTimeout(() => {
      if (this.stopped) return;
      for (const [, w] of this.watchers) {
        try { w.close(); } catch { /* ignore */ }
      }
      this.watchers.clear();
      this.attachWatches();
    }, delay);
  }
}

/** 列目录的直接子目录(非递归)。Linux 补 watch 用。 */
function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir)
      .map((n) => join(dir, n))
      .filter((p) => {
        try { return statSync(p).isDirectory(); } catch { return false; }
      });
  } catch {
    return [];
  }
}
