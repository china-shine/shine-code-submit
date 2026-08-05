---
name: report
description: 汇总当天 Claude Code 会话统计(工时/token/代码量),智能判断每段工作归属的禅道项目与任务,经用户确认后调用禅道 API 填报工时。Use when 用户要求填报工时、上报工时、报工、提交禅道工时,或运行 /report。
---

# ZenPilot 工时填报

把当天的编码会话数据归属到禅道任务并填报工时。

> **调用约定**:脚本 = `<Base directory>/scripts/zentao.ts`(Base directory 见启动信息)。**所有命令都在当前项目目录下用绝对路径调用、不要 cd 到插件目录**——脚本靠 `process.cwd()` 识别项目,数据按项目隔离写入 `~/.zenpilot/projects/<编码项目路径>/`。若已 cd,加 `--cwd "$PWD"`。

## 前置检查

配置一般在 setup 时已就绪,直接跑 plan。若 plan 报配置/登录错,再 `bun "<Base directory>/scripts/zentao.ts" check` 排查(或 `/shine-worklog:setup`)。

## 流程

**读缓存 → 总结 → 提交**:plan 一步读 summary(积累的 note 结论)+ 算增量工时 + 防重 + cooldown 预判;AI 把 note 结论归纳成 3-5 总结性 work;render 确认后 commit。流程顺序 **plan → AI 总结 work → render → 确认 → commit**。`plan.cooldown` 非空时告知用户等待(不 commit);全 already 时无需提交。

### 准备阶段(建议先跑 /prepare,让本流程秒级)

`/shine-worklog:prepare` 提前把当天会话的 work+task 算好写入 summary(本 skill 的 plan 直读为 resolved)。**先跑 prepare,下面的 auto 就能跳过最耗时的 AI 填空、全 resolved 秒级提交**。开工/工作中/收工前任意时机跑一次即可;uncertain(多任务判不准)的会留到 /report 用 AskUserQuestion 问。

### auto 一键(追求速度、work 不归纳)

> auto 直接 commit 用 join 的 note 原文(work 是结论拼接、不归纳)。**要总结性 work 走下面的分步(collect → plan → AI 综合 → render → commit)**;只在不在意 work 文案、追求秒级时用 auto。

summary 记全时,/report 可一步跑完,不用分步:

```
bun "<Base directory>/scripts/zentao.ts" auto        # 默认直接提交;加 --dry-run 只预览不提交
```

auto 内部 collect → plan →(全 resolved)→ commit 一次跑完,**默认自动提交、不再逐条确认**(summary 自记归属可信,错可 amend)。按返回的 `action` 分支处理:

- `committed` — 已提交:用 `result`(成功/跳过条数、每条任务) + `draft`(草稿文本)直接汇报,本次只 1 次工具调用。
- `needs_review` — 有 `pending`(needs_semantic)或 `noWork`(resolved 缺 work):只对这些条目走下面的「AI 填空」,改 plan.json 后跑 `commit`(其余条目已就绪,无需重跑 auto)。**下次可先跑 `/shine-worklog:prepare` 把 AI 填空前置,本动作即变秒级**。
- `cooldown` — 距上次提交 < 30 分钟:告知用户需等待 `waitMinutes` 分钟。
- `nothing` — 全 already/skipped,无可提交:说明本次无需提交。
- `abort` — collect 失败(通常 daemon 未启动):提示用户启 daemon 或走分步 collect 排查。

> auto 只在「全 resolved」时自动提交;只要有一条 needs_semantic 或缺 work,就停在 `needs_review` 让 AI 处理——不会盲目提交归属未定的工时。

### 开发时记 summary(省 AI 填空,强烈建议)

> 更省事:直接跑 `/shine-worklog:prepare`,AI 一次性读 transcript 批量生成当天所有会话的 work+task 写 summary,无需手动一条条记。下面的手动 `note` 适合「边做边记」或补 prepare 漏掉的单条。

**完成一个功能模块后,立即**记一条 summary(不等 /report):

```
bun "<Base directory>/scripts/zentao.ts" note --work "一句话:这段工作的核心成果" --task <任务ID>
```

- `--work`:**一句话精炼结论**(这段的核心成果),不罗列功能点——/report 时 AI 会把多条结论归纳成 3-5 个总结提交,细节留 transcript(✗ `1.功能A\n2.功能B` 流水账;✓ `实现X功能,达成Y效果`)
- `--task`:关联的禅道任务 ID(开发时已知,如本会话做的归 #77563 就传 77563)
- `--session`:可选,未传自动取当天最新活跃会话
- 写入 `~/.zenpilot/projects/<编码项目>/summary-YYYY-MM-DD.json`,taskName/project 从 cache.json 自动补

`plan` 会优先读 summary:**有 summary 的会话直接 `resolved`(置信度 100,跳过 AI 语义匹配 + 文案生成)**,工时仍取 daemon 的 session 活跃时长。开发时都记了,/report 的「AI 填空」步骤基本为空,省掉最耗时的推理。

### 1. plan(读缓存:summary + 工时 + 防重 + cooldown 预判)

```
bun "<Base directory>/scripts/zentao.ts" plan
```

一步读 `sessions.json`(Stop hook 每轮自动从 transcript 挖掘写入,**不需主动 collect**)+ summary + submitted,输出 `plan.json` + 返回 `cooldown`。按返回分三个分支:

- **`cooldown` 非空**(距上次提交<30min):告知用户"距上次提交需等 `waitMinutes` 分钟",**停止,不 render/commit**。
- **全 `already`**(已提交且增量<15min):无需提交,render 空草稿说明本次无需。
- **有 `resolved`**:进第 2 步(AI 总结 work)。`resolved` = 分支名含任务号 / 已提交增量补报 / summary 记录(work+task 已就绪);`needs_semantic`(无 summary,附 candidates)罕见,走下面的语义匹配。

> 防 `work=null`:已提交会话的增量补报,work 取"提交水位之后记的新 note";若为 null 说明这段没记 note(或水位时序),AI 据 note/上下文补一句总结写 plan.json。

### 2. AI 填空(直接编辑 plan.json)

1. **语义匹配**:对每个 `needs_semantic` 条目,比较 `summary` 与 `candidates` 任务名,选最可能的任务,写入 `task`、`confidence`(0-100)、`reason`(一句话),状态改为 `resolved`。置信度 ≥85 自行确定;<85 或无合理候选(匹配失败)时,用 AskUserQuestion 给出以下选项让用户选(按候选情况取舍,AskUserQuestion ≤4 个选项):
   - **更新禅道缓存后重新匹配** — 候选明显不全/陈旧(仓库映射到的项目候选为空、或禅道新加了任务还没进缓存)时首选:执行 `refresh` 重拉任务/项目 → 重跑 `plan` 重新匹配(新任务会进缓存)
   - **根据总结创建新任务** — 候选都不对、这是个新方向时:走下面的自动建任务流程(任务名/desc 由会话 summary 生成),拿到新任务 ID 填入条目(`task`/`taskName`/`project`/`projectName`),`reason` 标注「本次新建」
   - **选某个候选** — 有合理候选(只是置信度低)时:逐个列出 candidates,top1 标 Recommended
   - **跳过此会话** → `status: "skipped"`,填 `skipReason`
2. **合并简化 work(激进归纳)**:每个 `resolved` 条目,把 `item.work`(plan 读出的 note 结论拼接)**激进合并简化**写入 `work`:
   - 相似/相关功能**合并成一句话**(如"/report 提速 + 自动记 + dashboard"合一句"实现工时自动填报闭环")
   - 目标条目数:日报 **≤3 条**、周报 **≤5 条**;每条**就一句话核心成果(动宾),不加括号补充技术细节**
   - **严禁小括号列技术细节**(如 ✗ `(DATA_DIR+API+UI+样式+批量+预览)`,✓ 直接写"新增 dashboard 日报/周报模块")
   - **严禁逐条罗列 note 内容**(流水账);归纳成几个大主题,细节留 transcript

高置信度条目不打扰用户;所有归属问题必须在这一步问完。

### 3. 草稿与确认

```
bun "<Base directory>/scripts/zentao.ts" render
```

渲染工时草稿纯文本(编号自动递增;计划中还有 `needs_semantic` 或缺 `work` 的条目会直接报错——这保证了草稿永远是问完归属之后、确认提交之前的最后一步)。

把 render 输出**原样**放进代码块展示给用户,随后立刻用 AskUserQuestion 请用户确认整批提交(提交 / 调整 / 取消)。**未经确认绝不 commit**。

- 用户要求调整(改归属/改工时/改文案/按比例拆分/剔除)→ 改 plan.json 对应字段 → 重新 render → 再确认。拆分 = 复制条目,同 session 不同 task,工时按比例分
- 即使没有任何可提交条目(全部 already/skipped),也照常 render 展示草稿,并说明本次无需提交

### 4. 提交与汇报

```
bun "<Base directory>/scripts/zentao.ts" commit        # 支持 --dry-run 预览
```

脚本按计划逐条提交工时,并自动完成:写 `submitted.json` 防重记录、学习 仓库→项目 映射。剩余工时默认按 `原剩余 - 本次工时` 计算,条目里加 `left` 字段可覆盖。

**提交冷却**:两次 commit 间隔不得低于 30 分钟,脚本自动拦截;被拦时把剩余等待分钟数告知用户。

**修正最后一次提交**:仅当用户明确要求,绝不主动。走 amend skill(`/amend`)的流程,commit 被冷却拦截且用户想修正上一笔时也转入该流程。

最后汇报:成功/跳过条数、每条任务的消耗与剩余工时、token 与代码量统计(参考信息,不计入工时)、新学习到的映射。

#### 自动建任务流程

1. `bun "<Base directory>/scripts/zentao.ts" executions` 拉取进行中的执行列表
2. 用 AskUserQuestion 让用户选执行项目(必填,列出 执行名+ID+所属项目;能从映射缓存推断出最可能的执行时,把它放第一个并标 Recommended)
3. 任务名由会话 summary 精简生成(一句话、动宾结构),预计工时 = 该会话工时,类型默认 devel,desc 用完整 summary;这些自动生成项在选执行的同一个 AskUserQuestion 里展示,用户可通过 Other 修改
4. 创建并指派给自己:

   ```
   bun "<Base directory>/scripts/zentao.ts" create-task --execution <执行ID> --name "<任务名>" \
     --estimate <工时> --desc "<会话 summary>"
   ```

## 注意

- 禅道数据(项目/任务/执行)本地缓存于 `cache.json`(`DATA_DIR/zenpilot/`,全局),`plan`/`executions` 默认读缓存、不请求禅道(禅道内容一般不变)。匹配失败(候选不全/陈旧)时,第 2 步 AskUserQuestion 已把「更新缓存后重新匹配」作为显式选项——选它即执行 `bun "<Base directory>/scripts/zentao.ts" refresh` 重拉任务/项目、重跑 plan;用户主动说任务找不到/数据过期时同样跑 refresh;`create-task` 新建的任务会自动进缓存
- 用户显式要求补报/改报已提交会话时,可把该条目状态改回 `resolved` 绕过防重,但要提醒:禅道已有记录不会被覆盖,只会追加
- `submit`/`learn` 命令仍保留,用于计划外的手工修正;正常流程一律走 plan → render → commit
- 禅道 20.7 之前版本的旧请求体由脚本自动降级重试,无需关心
