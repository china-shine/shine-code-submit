// transcript 消费者:定期处理 SQLite 的 dirty 文件(增量读尾部 + 合并 entries + 全量算 token/activeMs),
// 写回 transcript_sessions。2s tick + 5min 兜底全扫(fs.watch 漏事件补救)。
// 算法走 sessionUsageAndActiveFromEntries(与 sessionUsageAndActiveFromRaws 同一 dedupe 链),与 scanSessions 口径逐字节等价。
import { openSync, readSync, fstatSync, closeSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Store, TranscriptFileRow } from "./store";
import { claudeProjectsRoots, collectJsonl } from "./claude-scan";
import {
  readUsageEntriesFromText,
  sessionUsageAndActiveFromEntries,
  readFirstUserTextFromText,
  readFirstCwdFromText,
  classifyTranscriptPath,
  type UsageDedupeEntry,
} from "./transcript";
import { Logger } from "./logger";

const TICK_MS = 2000;
const FULL_SCAN_MS = 5 * 60_000;
const MAX_FILES_PER_TICK = 100;
const MAX_SESSIONS_PER_TICK = 50;

/** 增量读:从 offset 读到文件尾,截到上一个 \n(半写行留下次补)。返回完整行文本 + 新 offset + mtime/size。 */
function readTailFromOffset(path: string, offset: number): {
  newLines: string;
  newOffset: number;
  mtimeMs: number;
  sizeBytes: number;
  truncated: boolean;
} {
  const fd = openSync(path, "r");
  try {
    const st = fstatSync(fd);
    const truncated = st.size < offset; // 文件被截短(罕见,append-only 不会,兜底)
    const start = truncated ? 0 : offset;
    const len = Math.max(0, st.size - start);
    const buf = Buffer.alloc(len);
    if (len > 0) readSync(fd, buf, 0, len, start);
    const text = buf.toString("utf8");
    const lastNl = text.lastIndexOf("\n");
    if (lastNl < 0) {
      // 尾部无完整行(写未刷盘):全部留待下次,不推进 offset
      return { newLines: "", newOffset: start, mtimeMs: st.mtimeMs, sizeBytes: st.size, truncated };
    }
    return { newLines: text.slice(0, lastNl), newOffset: start + lastNl + 1, mtimeMs: st.mtimeMs, sizeBytes: st.size, truncated };
  } finally {
    closeSync(fd);
  }
}

export class TranscriptConsumer {
  private log = new Logger("transcript-consumer");
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private fullTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private store: Store) {}

  start(): void {
    if (this.tickTimer) return;
    // 启动即跑一次兜底全扫(填冷启动 baseline + 补 watcher 启动前漏的),随后跑一次 tick
    setTimeout(() => {
      try { this.fullScanBackstop(); this.tick(); } catch (e) { this.log.info("startup scan failed", e); }
    }, 1000);
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    this.fullTimer = setInterval(() => this.fullScanBackstop(), FULL_SCAN_MS);
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.fullTimer) clearInterval(this.fullTimer);
    this.tickTimer = null;
    this.fullTimer = null;
  }

  /** 同步处理所有 dirty(循环 tick 直到无 dirty 或 maxRounds)。验证/启动填充用。 */
  drainAll(maxRounds = 100): void {
    for (let i = 0; i < maxRounds; i++) {
      this.tick();
      if (this.store.dirtyFiles(1).length === 0 && this.store.dirtySessions(1).length === 0) break;
    }
  }

  /** 2s tick:消费 dirty 文件 → 重算 dirty session。批次上限防长阻塞事件循环;running 标志防堆积。 */
  private tick(): void {
    if (this.running) return;
    this.running = true;
    try {
      const dirtyFiles = this.store.dirtyFiles(MAX_FILES_PER_TICK);
      for (const f of dirtyFiles) {
        try { this.consumeFile(f); } catch (e) { this.log.info(`consume ${f.path} failed`, e); }
      }
      const dirtySessions = this.store.dirtySessions(MAX_SESSIONS_PER_TICK);
      for (const s of dirtySessions) {
        try { this.recomputeSession(s.session_id); } catch (e) { this.log.info(`recompute ${s.session_id} failed`, e); }
      }
    } finally {
      this.running = false;
    }
  }

  /** 消费一个文件:增量读尾部 → 合并 SQLite 旧 entries → UPDATE(offset/entries/mtime,清 dirty)→ markSessionDirty。
   *  父文件首读(offset=0 且读了内容)顺带算 title/cwd(append-only,首 64 行永不变)。 */
  private consumeFile(f: TranscriptFileRow): void {
    const { newLines, newOffset, mtimeMs, sizeBytes, truncated } = readTailFromOffset(f.path, f.read_offset);
    let entries: UsageDedupeEntry[] = [];
    try { entries = JSON.parse(f.entries_blob) as UsageDedupeEntry[]; } catch { /* blob 损坏重置 */ }
    if (truncated) entries = [];
    if (newLines) {
      const newEntries = readUsageEntriesFromText(newLines);
      if (newEntries.length) entries = entries.concat(newEntries);
    }
    this.store.updateFileConsumed(f.path, newOffset, JSON.stringify(entries), mtimeMs, sizeBytes);
    this.store.markSessionDirty(f.session_id, f.project_id, f.parent_path);
    if (f.is_subagent === 0 && f.read_offset === 0 && newLines) {
      this.store.updateSessionHead(f.session_id, readFirstUserTextFromText(newLines), readFirstCwdFromText(newLines));
    }
  }

  /** 重算一个 session:聚合所有文件(父+子代理)entries → sessionUsageAndActiveFromEntries 全量算 → UPDATE 结果(清 dirty)。 */
  private recomputeSession(sessionId: string): void {
    const rows = this.store.filesForSession(sessionId);
    if (rows.length === 0) return;
    const allEntries: UsageDedupeEntry[] = [];
    let lastActivity = 0;
    const mtimeParts: string[] = [];
    for (const r of rows) {
      if (r.entries_blob) {
        try { for (const e of JSON.parse(r.entries_blob) as UsageDedupeEntry[]) allEntries.push(e); } catch { /* skip */ }
      }
      if (r.is_subagent === 0) lastActivity = r.mtime_ms; // 父文件 mtime,与 scanSessions 口径一致(子代理 mtime 不计入 session 活跃时间)
      mtimeParts.push(`${r.path}:${r.mtime_ms}`);
    }
    const { tokenTotal, activeMs } = sessionUsageAndActiveFromEntries(allEntries);
    this.store.updateSessionResult(sessionId, tokenTotal, activeMs, lastActivity, mtimeParts.join("|"));
  }

  /** 兜底全扫:遍历根 → 新文件插入 + mtime 变了的标 dirty(fs.watch 漏事件补救)。public 供启动/测试调。 */
  fullScanBackstop(): void {
    for (const root of claudeProjectsRoots()) {
      const files: string[] = [];
      collectJsonl(join(root, "projects"), files);
      for (const file of files) {
        const info = classifyTranscriptPath(file);
        if (!info) continue;
        let mtimeMs: number;
        try { mtimeMs = statSync(file).mtimeMs; } catch { continue; }
        const known = this.store.getFileMtimeMs(file);
        if (known !== mtimeMs) {
          // 新文件(known=null)或 mtime 变了(watcher 漏标) → 标 dirty 让消费者处理
          this.store.markFileDirtyOrInsert({
            path: file,
            sessionId: info.sessionId,
            projectId: info.projectId,
            parentPath: info.parentPath,
            isSubagent: info.kind === "subagent",
          });
        }
      }
    }
  }
}
