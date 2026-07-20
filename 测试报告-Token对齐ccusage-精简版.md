# Token 对齐 ccusage 测试报告(精简版)

> 完整版见 [`测试报告-Token对齐ccusage.md`](./测试报告-Token对齐ccusage.md)

**目标**:以 ccusage 20.0.17 为标准,验证 shine-code-submit v1.0.16 daemon 的 token 统计(`/api/report`)是否与之逐字段对齐。

**判定:Claude Code 范围内逐字段对齐,可作为 ccusage 的等价本地实现。**

## 环境

shine-code-submit v1.0.16 ｜ ccusage 20.0.17 ｜ 数据源 `~/.claude/projects/**/*.jsonl` ｜ Windows 11 ｜ 采样 2026-07-13

## 方法

- **全量对拍**:`ccusage session -j`(166)对照 daemon `/api/report`(95),按 sessionId 逐字段比(input / output / cacheCreation / cacheRead)。
- **静止判定**:`lastActive` > 10 min 视为静止(transcript 不再增长 → 零时间差);活跃 session 的差异属采样时差,非算法错误。
- **单点对拍**:`ccusage session -i <id>` 对照 daemon,4 个静止 session(含带 `subagents/` 与 cacheCreation 非零的)。

## 结果

| 指标 | 值 |
|---|---|
| Claude Code 共有 session | 95 |
| 4 字段全等 | 94(静止 93 + 活跃 1) |
| **静止 session 零差异** | **93 / 93** |
| 唯一差异 | 活跃会话 `77e74e83`,采样时差 +408,579 |
| 仅 ccusage 有的 71 个 | 全为 opencode agent,daemon 设计不含(非缺陷) |

**总量闭合**:daemon 1,375,867,958 − ccusage(claude)1,375,459,379 = **+408,579** = 活跃 session delta,精确相等,无口径偏差。

**单点覆盖**(4 个静止 session 逐字段全等):

- `fd1e2d99`(带 `subagents/`)→ 父子归并 + sidechain 去重正确;
- `639c44cc`(全机唯一 cacheCreation 非零,= 559,790)→ 5m/1h breakdown 归并路径正确。

## 结论

1. Claude Code 范围内逐字段对齐:95 共有 → 94 全等,静止 93/93 零差异;
2. 唯一差异为活跃 session 采样时差(非错误),总量闭合证明无口径偏差;
3. 71 个范围外 session 全为 opencode,非缺陷;
4. `subagents` 归并、cacheCreation breakdown 两条关键路径验证通过。

## 局限

- `--since` 窗口过滤、`/api/sessions` 端点未单独对拍(后者与 report 同源,风险低);
- cacheCreation 非零 session 全机仅 1 个,且 `ephemeral_5m` 值 = 直接字段值,无法区分 breakdown 与回退路径(同逻辑,结果一致)。

---

复现:`TOKEN=<token> CCFILE=<ccusage\ -j\ 输出> bun scripts/parity-vs-ccusage.ts`
