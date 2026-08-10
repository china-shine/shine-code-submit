# CLAUDE.md

本项目（livesetting = shine-worklog）的开发规则。

## 工时顺手记（shine-worklog summary）

本项目用 shine-worklog 跟踪 Claude Code 工时并自动填报禅道。开发时你（AI）顺手记 summary，能让 `/shine-worklog:report` 跳过最耗时的 AI 填空、秒级提交——用户不用主动 `/prepare`，工时在开发中"不知不觉"攒好。

### 何时记
**一轮对话完成时**(响应即将结束、要 Stop 前)记一次,而不是中途每个模块都打断去记:
- 一轮里可能干了多个功能模块 → 归纳成本轮几个核心成果;归属不同禅道 task 时按 task 拆多条 note。
- 调试、试错、来回改同一处**不算**;只有"我能对用户说清刚才做了什么"时才记。
- 纯问答/闲聊/别的项目这一轮没有代码成果 → 不记。

### 怎么记
```
bun skills/report/scripts/zentao.ts note --work "一句话:这段工作的核心成果" --task <禅道任务ID>
```
- `--work` 记**一句话精炼结论**(这段做了什么的核心成果),**不罗列功能点**——/report 时 AI 会把多条结论归纳成 3-5 个总结提交,细节留 transcript。
  - ✗ 流水账:`1. 新增 cmdPrepare\n2. 抽 extractTranscriptSignals\n3. 部署 cache`
  - ✓ 结论:`实现 /prepare 命令(提前批量准备 work+task),/report 直读秒级提交`
- 不传 `--session` 自动取当天最新活跃会话。
- 脚本自动拍快照当前会话工时水位（`notedActiveMinutes`）；**未提交会话**的多次 note 按时间段拆到各 task，不会重复算工时。**已提交会话的增量补报例外**：沿用原提交 task（不按多 note 拆），其增量 work 只用提交水位之后记的新 note。
- 不要把多个 task 揉进一条 note。
- `--task` 可省:不确定归属时记 `--task -1`(或省略,默认 -1),/report 时集中给出候选任务匹配,**不跳过、不打断用户问**。

### task 怎么定
- 上下文明确（对话里在做某个具体禅道任务）→ 直接用对应任务 ID。
- **不确定 → 记 `--task -1`**(不跳过、不瞎猜、不打断用户问);这些 -1 的 note 攒着,`/report` 时集中列出候选任务一次匹配。
- `/report` 提交顺序:先把 task>0 的提交完,task=-1 的停下来提示匹配,匹配好后和 task>0 的一次统一提交。

### 不要做的事
- 不要让用户主动提醒你记——这是你顺手做的，对用户"无形"。
- 不要中途记——一轮对话完成时再记,避免打断;也不要每轮都记(太碎,禅道多条 0.5h 无意义),有代码成果的轮才记。
- 不要用 git commit 触发记——本项目不依赖 git 判断工时。
