// transcript 关键信号提取:为 /report 的 AI 填空准备"决定性内容"素材。
// 设计依据(2026-08-17 对真实 transcript 三轮结构分析,见 tmp/analyze-*.ts):
//   - 约一半行是纯元数据(attachment/last-prompt/mode 等),thinking 是推理非结论 → 全部跳过;
//   - turn 边界有天然标识 type=system/subtype=turn_duration,每 turn 最后一条 assistant text 是"本轮结论";
//   - git commit -m 的 message、TaskCreate/Update 的 subject 是权威工作内容;
//   - away_summary 是 Claude Code 原生的本轮工作总结(覆盖率低,有则全收);ai-title 是 AI 会话标题(取最后)。
// 纯结构化规则、零 LLM;逐行独立判定 → 可随 transcript-consumer 增量追加(blob 状态 + 新行)。
// 只处理父 transcript(与 skills 侧 extractTranscriptSignals 同口径);不影响 token/activeMs 计算链。

/** 上限:防信号文件无界膨胀(DATA_DIR/signals 每会话一个 json)。 */
const MAX_TURNS = 300;
const MAX_PROMPTS_PER_TURN = 5;
const MAX_COMMITS_PER_TURN = 10;
const MAX_TASKS_PER_TURN = 10;
const MAX_FILES_PER_TURN = 20;
const MAX_FILES_SESSION = 50;
const MAX_SKILLS_PER_TURN = 5;
const MAX_AWAY = 20;
const PROMPT_MAX_CHARS = 200;
const CONCLUSION_MAX_CHARS = 800;
const AWAY_MAX_CHARS = 600;
const TASK_MAX_CHARS = 120;
const COMMIT_MAX_CHARS = 200;

export interface TurnSignal {
  startMs: number;
  endMs: number;
  prompts: string[];
  conclusion: string | null; // 本 turn 最后一条 assistant text(结论性汇报)
  commits: string[]; // git commit -m 首行(subject)
  taskSubjects: string[]; // TaskCreate/TaskUpdate/TodoWrite subject
  files: string[]; // Edit/Write/MultiEdit file_path(去重)
  added: number;
  removed: number;
  skills: string[]; // attributionSkill(识别 /report /daily 等报表类 turn)
}

export interface AwaySummary {
  ts: number;
  text: string;
}

export interface SessionSignals {
  aiTitle: string | null; // 最后一条 type=ai-title
  cwd: string | null; // 消息行携带的真实工作目录(供 API 精确过滤,防同编码目录碰撞)
  firstAt: number; // 首个带时间戳事件的 ts(0=未知;定信号文件归属日期,稳定不迁移)
  lastAt: number; // 最近事件 ts(供 API 按 since 过滤)
  awaySummaries: AwaySummary[];
  turns: TurnSignal[]; // 已闭合 turn(遇 turn_duration)
  open: TurnSignal | null; // 进行中 turn(未闭合;API 输出时并入 turns 尾部)
  toolUseCounts: Record<string, number>;
  filesChanged: string[]; // 全会话文件并集(独立于 turns,turns 丢最旧时不丢)
}

export function emptySignals(): SessionSignals {
  return { aiTitle: null, cwd: null, firstAt: 0, lastAt: 0, awaySummaries: [], turns: [], open: null, toolUseCounts: {}, filesChanged: [] };
}

/** blob → state;损坏/形状不对返回 null(调用方全量重读回填,对齐 entries_blob 容错风格)。 */
export function parseSignalsBlob(blob: string | null | undefined): SessionSignals | null {
  if (!blob) return null;
  try {
    const o = JSON.parse(blob);
    if (
      !o || typeof o !== "object" ||
      !Array.isArray(o.turns) || !Array.isArray(o.awaySummaries) || !Array.isArray(o.filesChanged) ||
      !o.toolUseCounts || typeof o.toolUseCounts !== "object" // typeof null === "object",需显式排空
    ) return null;
    return o as SessionSignals;
  } catch {
    return null;
  }
}

export function serializeSignals(state: SessionSignals): string {
  return JSON.stringify(state);
}

function emptyTurn(ts: number): TurnSignal {
  return { startMs: ts, endMs: ts, prompts: [], conclusion: null, commits: [], taskSubjects: [], files: [], added: 0, removed: 0, skills: [] };
}

function hasContent(t: TurnSignal): boolean {
  return t.prompts.length > 0 || t.conclusion !== null || t.commits.length > 0 || t.taskSubjects.length > 0 || t.files.length > 0 || t.added + t.removed > 0;
}

/** 与 skills 层 countLines 同口径(split("\n").length,空串 0)。 */
function countLines(s: unknown): number {
  if (typeof s !== "string" || s.length === 0) return 0;
  return s.split("\n").length;
}

/** 从 Bash command 提取 git commit message 首行;非 commit / 提不出 message 返回 null。 */
export function extractCommitSubject(command: string): string | null {
  if (!/git\s+commit/.test(command)) return null;
  // heredoc:-m "$(cat <<'EOF'\nfeat: xxx\n\nbody\nEOF\n)"
  const heredoc = /<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1/.exec(command);
  const quoted = /-m\s+"((?:[^"\\]|\\.)*)"/.exec(command) ?? /-m\s+'([^']*)'/.exec(command);
  const raw = heredoc?.[2] ?? quoted?.[1];
  if (!raw) return null;
  const first = raw
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!first) return null;
  return first.replace(/\\"/g, '"').slice(0, COMMIT_MAX_CHARS);
}

/** 真实用户提问:非空、非 XML wrapper(<command-*>/<system-reminder> 等)、非 Caveat 注入、非中断标记、非超长粘贴。 */
export function isRealUserPrompt(text: string): boolean {
  const t = text.trim();
  if (t.length <= 1 || t.length > 500) return false;
  if (t.startsWith("<")) return false;
  if (/^Caveat:/i.test(t)) return false;
  if (t.startsWith("[Request interrupted")) return false;
  return true;
}

function pushCapped(arr: string[], v: string, cap: number): void {
  if (arr.length < cap && !arr.includes(v)) arr.push(v);
}

function tsOf(obj: Record<string, unknown>): number {
  const v = obj.timestamp;
  const n = typeof v === "string" ? Date.parse(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
}

/** 逐行按标识规则更新 state(增量安全:每行独立判定,不依赖跨行状态除 open turn)。返回同一 state 引用。 */
export function parseSignalEvents(raw: string, state: SessionSignals): SessionSignals {
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = tsOf(ev);
    if (ts && !state.firstAt) state.firstAt = ts;
    // cwd 取首条(first-wins,对齐 daemon readFirstCwdFromText 惯例):行内 cwd 是"当时"工作目录,
    // 会话中 cd 子目录会变——last-wins 会存成子目录路径,与项目目录不再对应,/api/signals 按 cwd 精确过滤会整个查不到
    if (!state.cwd && typeof ev.cwd === "string" && ev.cwd) state.cwd = ev.cwd;

    if (ev.type === "ai-title") {
      if (typeof ev.aiTitle === "string" && ev.aiTitle) state.aiTitle = ev.aiTitle;
      continue;
    }
    if (ev.type === "system" && ev.subtype === "away_summary") {
      if (typeof ev.content === "string" && ev.content.trim()) {
        state.awaySummaries.push({ ts, text: ev.content.trim().slice(0, AWAY_MAX_CHARS) });
        if (state.awaySummaries.length > MAX_AWAY) state.awaySummaries.shift();
        if (ts) state.lastAt = ts;
      }
      continue;
    }
    if (ev.type === "system" && ev.subtype === "turn_duration") {
      // turn 边界:闭合 open(有内容才入列)
      if (state.open) {
        const t = state.open;
        t.endMs = ts || t.endMs;
        if (hasContent(t)) {
          state.turns.push(t);
          if (state.turns.length > MAX_TURNS) state.turns.shift();
        }
        state.open = null;
        state.lastAt = t.endMs;
      }
      continue;
    }

    const message = ev.message as Record<string, unknown> | undefined;
    if (!message) continue; // attachment/last-prompt/mode 等元数据行
    const role = message.role;
    const content = message.content;

    if (role === "user" && !ev.isMeta) {
      let text = "";
      if (typeof content === "string") text = content;
      else if (Array.isArray(content)) {
        text = content
          .filter((b) => (b as Record<string, unknown>)?.type === "text")
          .map((b) => (b as Record<string, unknown>).text as string)
          .join("\n");
      }
      if (!isRealUserPrompt(text)) continue;
      if (!state.open) state.open = emptyTurn(ts);
      pushCapped(state.open.prompts, text.trim().replace(/\s+/g, " ").slice(0, PROMPT_MAX_CHARS), MAX_PROMPTS_PER_TURN);
      state.open.endMs = ts || state.open.endMs;
      state.lastAt = state.open.endMs;
      continue;
    }

    if (role !== "assistant" || !Array.isArray(content)) continue;
    let touched = false; // 是否有有效贡献(有才推进 open 的 endMs/懒建)
    const openRef = (): TurnSignal => {
      if (!state.open) state.open = emptyTurn(ts);
      return state.open;
    };
    for (const b of content) {
      const block = b as Record<string, unknown>;
      if (!block) continue;
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        openRef().conclusion = block.text.trim().slice(0, CONCLUSION_MAX_CHARS); // 最后一条胜出=结论
        touched = true;
      } else if (block.type === "tool_use") {
        const name = typeof block.name === "string" ? block.name : "unknown";
        state.toolUseCounts[name] = (state.toolUseCounts[name] ?? 0) + 1;
        const input = (block.input ?? {}) as Record<string, unknown>;
        const turn = openRef();
        touched = true;
        if (name === "Bash" && typeof input.command === "string") {
          const subject = extractCommitSubject(input.command);
          if (subject) pushCapped(turn.commits, subject, MAX_COMMITS_PER_TURN);
        } else if (name === "Edit" || name === "Write" || name === "MultiEdit") {
          if (typeof input.file_path === "string") {
            pushCapped(turn.files, input.file_path, MAX_FILES_PER_TURN);
            pushCapped(state.filesChanged, input.file_path, MAX_FILES_SESSION);
          }
          if (name === "Edit") {
            turn.added += countLines(input.new_string);
            turn.removed += countLines(input.old_string);
          } else if (name === "Write") {
            turn.added += countLines(input.content);
          } else if (Array.isArray(input.edits)) {
            for (const e of input.edits as Array<Record<string, unknown>>) {
              turn.added += countLines(e.new_string);
              turn.removed += countLines(e.old_string);
            }
          }
        } else if (name === "TaskCreate" || name === "TaskUpdate") {
          if (typeof input.subject === "string" && input.subject.trim()) {
            pushCapped(turn.taskSubjects, input.subject.trim().slice(0, TASK_MAX_CHARS), MAX_TASKS_PER_TURN);
          }
        } else if (name === "TodoWrite" && Array.isArray(input.todos)) {
          for (const t of input.todos as Array<Record<string, unknown>>) {
            if (typeof t.subject === "string" && t.subject.trim()) {
              pushCapped(turn.taskSubjects, t.subject.trim().slice(0, TASK_MAX_CHARS), MAX_TASKS_PER_TURN);
            }
          }
        }
      }
    }
    if (touched && state.open) {
      if (typeof ev.attributionSkill === "string" && ev.attributionSkill) {
        pushCapped(state.open.skills, ev.attributionSkill, MAX_SKILLS_PER_TURN);
      }
      state.open.endMs = ts || state.open.endMs;
      state.lastAt = state.open.endMs;
    }
  }
  return state;
}
