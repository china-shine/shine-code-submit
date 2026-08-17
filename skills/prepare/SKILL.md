---
name: prepare
description: 提前为今日会话生成工作内容+任务写入工时记录,让 /report 秒级提交。把 /report 最耗时的 AI 填空(语义匹配任务+拆文案)前置到任意时机完成,填报时直接执行。当用户要求准备工时、提前算工时、加速 /report、提前生成工时草稿,或运行 /prepare 时使用。
---

# shine-worklog 提前准备工时

把当天会话的 `work`(工作内容)+ `task`(禅道任务归属)**提前**算好写入 summary,这样 `/report` 时全 `resolved`、秒级提交,不用在填报时干等 AI 推理。

脚本在 report skill:`<Base directory>/../report/scripts/zentao.ts`。**用绝对路径在当前项目目录下调用、不要 cd**——脚本靠 `process.cwd()` 识别项目,summary 按项目隔离写入 `DATA_DIR/zenpilot/projects/<编码项目路径>/summary-YYYY-MM-DD.json`。

> prepare **只写 summary,不提交、不碰 submitted.json、不受 30 分钟提交冷却影响**,可随时重跑、增量补。

## 流程

### 1. 跑 prepare,按 action 分支

```
bun "<Base directory>/../report/scripts/zentao.ts" prepare
```

按返回的 `action` 分支处理:

- `ready` — 所有会话已就绪(已有 summary 或分支名含任务号):告知用户「N 条就绪,可直接 /report 秒级提交」,展示 `summary` 与 `ready` 列表,停止。
- `needs_cache` — 禅道任务缓存为空:引导用户跑 `/shine-worklog:report`(内部会 refresh)或直接 `zentao.ts refresh` 拉取任务,然后重跑 prepare。停止。
- `abort` — collect 失败(通常 daemon 未启动):提示用户启 daemon 或走分步 collect 排查。停止。
- `prepare_needed` — 有 `pending` 会话需准备,进入第 2 步。

### 2. 为每个 pending 生成 work + 选 task + 写 summary

对 `pending` 数组的每个条目,基于 `signals`(daemon 预提取,优先)或 `transcript`(退化直读)处理:

**生成 work**(功能点编号文案,动宾、每条一个功能点,同 commit 的 work 规范):
- `signals` 非空:以 `turns` 逐轮 `conclusion`(Claude 本轮结论汇报)为主料,`commits`/`taskSubjects` 佐证,`prompts` 补意图
- `signals` 为 null:据 `transcript.recentAssistantTexts` + `prompts`(用户要求)+ `filesChanged`+ `toolUseCounts`
- 形如 `1. 修复登录超时\n2. 新增 prepare 命令\n3. 重构 getCache 支持离线`
- 两者皆 null 时退化用 `daemonSummary`+`filesChanged` 推断

**选 task**:
- `submittedState=increment`(已提交会话的增量补报):**沿用现有 `task`**,不需选,只补 work
- `status=needs_semantic`:从 `candidates` 选最匹配的——置信度 ≥85 直接定;<85 或候选模糊时,仍生成 work 并记下 `topCandidates`(`[{id,name,reason}]`),但**不调 note**(留到 /report 时用 AskUserQuestion 问用户)

**写 summary**(仅对已确定 task 的条目):
```
bun "<Base directory>/../report/scripts/zentao.ts" note --session <session> --work "<生成的work>" --task <task>
```
note 自动补 `taskName`/`project` 并追加到 `summary-YYYY-MM-DD.json`。

### 3. 汇报(不主动跑 report)

- 就绪条数、uncertain(留 /report 确认)条数
- 告知用户:就绪后跑 `/shine-worklog:report` 即秒级提交;uncertain 的会在 /report 时用 AskUserQuestion 列出 topCandidates 让用户选
- **不主动调 /report**——prepare 只准备,提交是用户的填报动作

## 注意

- uncertain 条目不强行 note:没写 summary 的会话在 `/report auto` 自然走 `needs_review` + AskUserQuestion,复用这里留的 `topCandidates`,**不重读 transcript**
- `signals` 来自 daemon 后台预提取(`DATA_DIR/signals/<编码项目>/<日期>/<sessionId>.json`,consumer 持续增量更新);daemon 不可达/老会话未提取时为 null,`transcript` 现场直读 `~/.claude/projects/<编码cwd>/<sessionId>.jsonl`;跨项目或不存在的会话两者皆 null,退化处理
- 全部就绪后仍让用户自己跑 /report 确认提交——prepare 不替用户做提交决定
- prepare 不请求禅道、纯本地;`needs_cache` 是唯一需要先联网(refresh)的前置
