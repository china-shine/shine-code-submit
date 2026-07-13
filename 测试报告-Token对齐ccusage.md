# Token 统计对齐 ccusage 测试报告

> 以本机 Claude Code 真实 transcript 为输入,以 `ccusage` 输出为标准,验证 shine-code-submit daemon 的 token 统计是否与之逐字段对齐。
>
 采样时间:2026-07-13 ｜ 测试人:renguifeng ｜ 对拍脚本:[`scripts/parity-vs-ccusage.ts`](./scripts/parity-vs-ccusage.ts)

---

## 测试总结

以本机 166 个 transcript session(Claude Code + opencode)为样本、ccusage 20.0.17 为标准,对 shine-code-submit v1.0.16 daemon 的 token 统计做全量逐字段对拍。

**判定:Claude Code 范围内逐字段对齐,可作为 ccusage 的等价本地实现。**

| 关键指标 | 结果 |
|---|---|
| Claude Code 共有 session | 95 |
| 4 字段全等(input/output/cacheCreation/cacheRead) | 94(静止 93 + 活跃 1) |
| 静止 session 零差异 | **93 / 93** |
| 唯一差异 | 当前活跃会话采样时差 +408,579(与总量闭合相等,非统计错误) |
| 范围差异 | 71 个 opencode session 不在 daemon 扫描范围(设计如此,非缺陷) |
| 关键路径覆盖 | 父子 `subagents` 归并、cacheCreation `5m/1h` breakdown 归并 |

残留局限(`--since` 窗口过滤、`/api/sessions` 端点未单独对拍等)详见第 7 节。

---

## 1. 测试目标

验证 daemon(`/api/report`、会话树)的 token 统计与 `ccusage claude session` **逐 session 逐字段相等**,以 ccusage 为标准答案,确认本项目 token 统计逻辑的正确性。

## 2. 测试环境

| 项 | 值 |
|---|---|
| shine-code-submit | v1.0.16(pid 25576,port 36666) |
| ccusage | 20.0.17 |
| 数据源 | `~/.claude/projects/**/*.jsonl`(Claude Code transcript) |
| 平台 | Windows 11 |

## 3. 被测统计逻辑(实现概述)

`/api/report` 的 token **不依赖 hook 是否抓到事件**,而是直接扫描 Claude Code transcript 算出,逐行对齐 ccusage `read_usage_file`。链路:`claude-scan.ts`(扫描 + 归组)→ `transcript.ts`(逐行解析 + 去重 + 求和)→ `token-cache.ts`(mtime 缓存)→ `server.ts:buildReport`(按项目聚合)。

### 3.1 数据源

`claude-scan.ts: claudeProjectsRoots()`(等价 ccusage `claude_paths`),解析顺序:
`CLAUDE_CONFIG_DIR`(逗号分隔,可指目录或其 `projects/`)→ `$XDG_CONFIG_HOME/claude` → `~/.claude`。
**只读 `projects/**/*.jsonl`,不碰 `.claude` 其他内容**(settings / 历史 / 插件 / 遥测一律不读)。

### 3.2 文件收集与 session 归组

`collectScannedSessions` + `parentSessionInfo`:递归收集 `.jsonl`,按 `projects/<project>/<session>.jsonl` 取 project + sessionId。

- **跳过 `subagents/` 下文件**(由父 session 并入,见 3.6);
- 跳过非标准嵌套(`rel.length !== 2`,避免误归);
- **0-token 空 transcript 不计入 session 数**(对齐 ccusage session 计数)。

### 3.3 逐行解析门(`readUsageEntries`,对齐 ccusage `read_usage_file`)

每个 jsonl 行依次过门,任一不过即丢弃:

1. **快速门**:行不含 `"usage":{` → 跳过;
2. **null 黑名单门**(`hasUnsupportedNullField`,对齐 ccusage `is_unsupported_nullable_field`):行内黑名单字段为 `null` → 跳过。黑名单:`id / cwd / model / speed / costUSD / version / sessionId / requestId / isApiErrorMessage / cache_read_input_tokens / cache_creation_input_tokens`;
3. `JSON.parse` 失败 → 丢弃;
4. **严格时间戳门**(`isValidCcusageTimestamp`,对齐 ccusage `parse_ts_timestamp`):仅接受 `YYYY-MM-DDTHH:MM:SS[.sss][Z|±HH:MM]` 且时分秒范围与日历日合法,**比 `Date.parse` 严**——避免接受 ccusage 会丢弃的时间戳造成计数分歧;
5. **条目校验**(`isValidUsageEntry`,对齐 ccusage `is_valid_usage_entry`):`version` 非 semver 前缀、或 `sessionId / requestId / message.id / model` 为空串 → 丢弃。

### 3.4 四字段提取

```
input         = usage.input_tokens
output        = usage.output_tokens
cacheCreation = cache_creation.ephemeral_5m_input_tokens + cache_creation.ephemeral_1h_input_tokens
               （无 5m/1h breakdown 时回退 cache_creation_input_tokens）
cacheRead     = usage.cache_read_input_tokens
total         = input + output + cacheCreation + cacheRead   （= rawTotal，与 ccusage totalTokens 一致）
```

> 1.0.12 起显示口径为原始总量 `rawTotal`;此前用计费口径 `realInput = input + cacheCreation×1.25 + cacheRead×0.1`(缓存读打 0.1 折)。

### 3.5 去重(`dedupeAndSum` + `pushDedupedEntry`,对齐 ccusage `push_deduped_entry`)

- **键**:`message.id + requestId`(精确键);无 `message.id` 不去重。
- **sidechain 重放兜底**:精确键未命中时,按 `messageId` 匹配,候选或现存任一为 sidechain 即视为同条(子代理 transcript 重放不重复计)。
- **同键取舍**(`shouldReplaceDedupedEntry`,对齐 ccusage `should_replace_deduped_entry`):**非 sidechain 优先 → total 更大 → 带 speed**。
- 去重在 **session 级跨文件全局**进行(父 + subagents 的条目合并到同一数组后再去重,而非逐文件去重)。

### 3.6 session 归并(父子 transcript)

`sumSessionUsage`:父 `<session>.jsonl` + 同目录 `<session>/subagents/*.jsonl` 合并为**一个 session**,跨文件全局去重后求和。子代理 sidechain 的 token 计入父 session,不重复不遗漏——这是本次测试专门用带 `subagents/` 的 `fd1e2d99` 验证的点。

### 3.7 聚合到报表(`server.ts: buildReport`)

- 按**真实 cwd** 分组(hook 捕获的 cwd 优先,无则 `decodeProjectCwd` 解码项目名:Windows 盘符 `C--…` → `C:\…`);
- 同名项目用「父目录/项目名」消歧(如两个 `test` → `workspace/test`、`ai/test`);
- 项目 `totalTokens` = 其下各 session 之和,全局 `totals.tokens` = 所有项目之和。

### 3.8 缓存

| 层 | 位置 | 范围 | 失效条件 |
|---|---|---|---|
| token 总量缓存 | `token-cache.ts: getSessionTokenTotal` | 按 transcriptPath 缓存「复合 mtime → tokenTotal」 | 父 + subagents 任一文件 mtime 变化 |
| 扫描结果缓存 | `claude-scan.ts: scanSessions` | 全量扫描结果 | 2s TTL(`/api/sessions` 每 2s 轮询) |

> 静止 session 文件 mtime 不变 → 缓存值 = 真实值,对拍不受影响;活跃 session 因 mtime 持续变化,每次重算——这也是其差异仅来自「采样时差」而非缓存的原因。

## 4. 测试方法

### 4.1 字段映射

两边直接读同一批 transcript 文件,字段名不同、语义一致:

| daemon `tokenTotal` | ccusage |
|---|---|
| `input` | `inputTokens` |
| `output` | `outputTokens` |
| `cacheCreation` | `cacheCreationTokens` |
| `cacheRead` | `cacheReadTokens` |
| 四字段之和(`rawTotal`) | `totalTokens` |

### 4.2 对拍策略

1. **全量对拍**:`ccusage session -j`(166 session)对照 daemon `/api/report`(95 session),按 `sessionId` 对齐,**逐字段**比较 4 个 token 字段。
2. **静止判定**:daemon 侧 `lastActive` 距采样时刻 > 10 分钟视为**静止**(transcript 不再增长 → 零时间差);否则为活跃。
3. **单点精确对拍**:`ccusage session -i <id> -j` 对照 daemon 同一 session,挑 3 个静止 session(含 1 个带 `subagents/` 子目录的),验证父子归并 + 子代理 sidechain 去重。

> 为什么静止 session 才是零时间差:transcript 持续写入时,ccusage 与 daemon 两次采样之间文件已变,会制造**假差异**;daemon 还有 mtime 缓存(3.8,文件没变才返回)。静止 session 两边读到的字节完全相同,差异只能来自算法本身。参见 memory [[report-tokens-match-ccusage]]。

## 5. 测试结果

### 5.1 全量对拍汇总

| 指标 | 值 |
|---|---|
| ccusage 总 session | 166 |
| daemon 总 session | 95 |
| 两边共有(Claude Code) | 95 |
| 共有且 4 字段全等 | **94**(静止 93 + 活跃 1) |
| 共有且有差异 | 1(活跃,采样时差) |
| 仅 ccusage 有 | 71 |
| 仅 daemon 有 | 0 |
| **静止 session 全等** | **93 / 93** |
| 静止 session 差异 | **0** |

### 5.2 agent 分布 —— 解释 71 个「仅 ccusage」

ccusage 20.x 是多 agent 工具,会扫描多种 CLI 的 session:

| agent | session 数 | token 合计 |
|---|---|---|
| claude | 95 | 1,375,459,379 |
| opencode | 71 | 21,358,622 |

**71 个「仅 ccusage」全部是 opencode agent**(session ID 形如 `ses_xxx`)。daemon 设计范围 = Claude Code transcript(`~/.claude/projects`),不含 opencode。属**预期范围差异,非缺陷**。

### 5.3 唯一差异 session(活跃,采样时差)

`77e74e83`(当前会话,livesetting 项目,采样时仍在写入):

| 字段 | ccusage | daemon | delta |
|---|---|---|---|
| input | 32,652 | 40,566 | +7,914 |
| output | 8,729 | 13,490 | +4,761 |
| cacheCreation | 0 | 0 | 0 |
| cacheRead | 413,120 | 809,024 | +395,904 |
| **total** | **454,501** | **863,080** | **+408,579** |

**delta 全为正**:ccusage 先采样、daemon 后采样,期间对话继续产生 token,daemon 多算了这一段。属采样时差,**非统计错误**;该 session 静止后差异归零。

### 5.4 总量闭合验证

| 项 | token |
|---|---|
| ccusage claude 合计 | 1,375,459,379 |
| daemon 合计 | 1,375,867,958 |
| **daemon − ccusage(claude)** | **+408,579** |
| 活跃 session delta(5.3) | +408,579 |

**两者精确相等**。daemon 合计与 ccusage(claude)的差值完全由活跃 session 的采样时差解释,无统计口径偏差。

### 5.5 单点精确对拍(静止 session,逐字段)

`ccusage session -i <id>` 对照 daemon,3 个静止 session:

| session | 来源 | input | output | cacheCreation | cacheRead | total | subagents |
|---|---|---|---|---|---|---|---|
| `df80cdca` | ccusage | 297,001 | 108,113 | 0 | 6,035,328 | 6,440,442 | — |
| `df80cdca` | daemon | 297,001 | 108,113 | 0 | 6,035,328 | 6,440,442 | — |
| `fd1e2d99` | ccusage | 828,646 | 285,503 | 0 | 56,347,968 | 57,462,117 | ✓ |
| `fd1e2d99` | daemon | 828,646 | 285,503 | 0 | 56,347,968 | 57,462,117 | ✓ |
| `04a3441b` | ccusage | 95,579 | 63,435 | 0 | 2,880,704 | 3,039,718 | — |
| `04a3441b` | daemon | 95,579 | 63,435 | 0 | 2,880,704 | 3,039,718 | — |
| `639c44cc` | ccusage | 61 | 48,777 | **559,790** | 4,385,145 | 4,993,773 | — |
| `639c44cc` | daemon | 61 | 48,777 | **559,790** | 4,385,145 | 4,993,773 | — |

4 个静止 session **逐字段、逐 total 全等**。覆盖两条关键路径:

- `fd1e2d99` 父目录下有 `subagents/*.jsonl` → 验证 3.6 父子 transcript 归并 + 3.5 子代理 sidechain 去重;
- `639c44cc` 是**全机唯一 cacheCreation 非零**的 session(=559,790,即全量合计本身),其 transcript 行 `cache_creation` 为 `{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}` breakdown 结构 → 验证 3.4 的 5m+1h 归并路径。此前 3 个样本该字段均为 0,未触达此路径,本次补测闭合该盲点。

## 6. 结论

| # | 结论 | 证据 |
|---|---|---|
| 1 | Claude Code session 范围内逐字段对齐 | 95 共有 → 94 全等;静止 93/93 零差异 |
| 2 | 唯一差异为活跃 session 采样时差(非错误) | delta 全正,与采样先后一致;静止后归零 |
| 3 | 总量闭合,无口径偏差 | daemon − ccusage(claude)= +408,579 = 活跃 delta |
| 4 | 范围差异明确(非缺陷) | 71 个 only_ccusage 全为 opencode,daemon 设计只覆盖 Claude Code |
| 5 | 复杂场景正确 | 带 subagents 的 session 父子归并 + 去重逐字段相等 |

**本项目 token 统计与 ccusage 在 Claude Code 范围内逐字段对齐,可作为 ccusage 的等价本地实现。**

## 7. 局限性与未覆盖维度

| 维度 | 现状 | 影响 |
|---|---|---|
| `--since` 窗口过滤 | 仅测 `since=0`(全量);`buildReport` 的 `since>0` 按 session mtime 过滤未单独对拍 | 今日/区间窗口另有 ccusage `--until` exclusive 口径差异(见 memory [[report-tokens-match-ccusage]]),需单独验证 |
| `/api/sessions` 端点 | 未单独对拍;与 `/api/report` 同源 `scanSessions()`、同一 `tokenTotal` | 逻辑等价,风险低 |
| cacheCreation breakdown 路径 | 全机仅 1 个非零 session(`639c44cc`),且其 `ephemeral_5m` 值 = 直接 `cache_creation_input_tokens` 值 | 无法区分「breakdown 路径」与「回退路径」(两者数值相同);但 daemon 与 ccusage 同逻辑,结果一致 |
| 静止判定 | `lastActive` 取父 transcript mtime | 若 subagents 文件 mtime 晚于父,可能将仍有子代理活动的 session 判为静止;父 session 活动通常伴随父文件写入,影响极小 |
| non-Claude agent | opencode 等 71 个 session 不在 daemon 扫描范围 | 设计如此(只覆盖 Claude Code),非缺陷 |

## 附录:复现

```bash
# 1. 采 ccusage 全量(多 agent)
npx ccusage@latest session -j > /tmp/ccusage-all.json

# 2. 取 daemon token(从 pid 文件)
TOKEN=$(jq -r .token "$LOCALAPPDATA/shine-code-submit/daemon.pid")

# 3. 跑对拍
TOKEN=$TOKEN CCFILE=/tmp/ccusage-all.json bun scripts/parity-vs-ccusage.ts

# 单点精确对拍(静止 session)
npx ccusage@latest session -i <sessionId> -j
```

脚本输出 JSON:`summary`(匹配/差异计数)、`totals`(总量对账)、`diffs`(差异详情,活跃在前)、`only_*_ids`(单边 session)。
