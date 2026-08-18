---
name: report
description: 汇总当天及上次提交以来未提交的 Claude Code 会话统计(工时/token/代码量),智能判断每段工作归属的禅道项目与任务,经用户确认后调用禅道 API 填报工时。当用户要求填报工时、上报工时、报工、提交禅道工时,或运行 /report 时使用。
---

# shine-worklog 工时填报

把**今天 + 自上次提交以来所有未提交**的编码会话数据归属到禅道任务并填报工时——某天忘了提交、或提交后还有增量,之后任意一次 `/report` 都会把它们补上(上限回看 14 天),补报条目按**会话实际日期**提交禅道。

> **调用约定**:脚本 = `<Base directory>/scripts/zentao.ts`(Base directory 见启动信息)。**所有命令都在当前项目目录下用绝对路径调用、不要 cd 到插件目录**——脚本靠 `process.cwd()` 识别项目,数据按项目隔离写入 `~/.zenpilot/projects/<编码项目路径>/`。若已 cd,加 `--cwd "$PWD"`。

## 前置检查

配置一般在 setup 时已就绪,直接跑 plan。若 plan 报配置/登录错,再 `bun "<Base directory>/scripts/zentao.ts" check` 排查(或 `/shine-worklog:setup`)。

## 流程

**读缓存 → 自动汇总日志 → 提交**:plan 读 summary(已有的 work+task 记录)+ 算增量工时 + 防重 + cooldown 预判;有 needs_semantic/缺 work 的会话读 transcript 自动归纳 work+task;render 确认后 commit。流程顺序 **plan → 自动汇总日志 → render → 确认 → commit**。`plan.cooldown` 非空时告知用户等待(不 commit);全 already 时无需提交。

### 准备阶段(auto-note 已自动完成大半)

**auto-note**:每轮对话结束(Stop hook)自动把该会话最新 turn 的结论精简成 work+推断 task 写入 summary(零 LLM、后台静默、10min 节流;`settings.json` 的 `autoNote:false` 可关)——大多数会话无需任何手动准备,`/report` 时已是 resolved。

**`/prepare`(补漏/重归纳)**:对 auto-note 没覆盖的会话(新项目首会话 task=-1、想要比 conclusion 更精炼的总结性文案、老会话无信号)手动前置归纳,同样写 summary 让 plan 直读。开工/工作中/收工前任意时机可跑;uncertain(多任务判不准)的留到 /report 用 AskUserQuestion 问。

### auto 一键(追求速度、work 不归纳)

> auto 直接 commit 用 join 的 note 原文(work 是结论拼接、不归纳)。**要总结性 work 走下面的分步(collect → plan → AI 综合 → render → commit)**;只在不在意 work 文案、追求秒级时用 auto。

summary 记全时,/report 可一步跑完,不用分步:

```
bun "<Base directory>/scripts/zentao.ts" auto        # 默认直接提交;加 --dry-run 只预览不提交
```

auto 内部 collect → plan →(全 resolved)→ commit 一次跑完,**默认自动提交、不再逐条确认**(summary 自记归属可信,错可 amend)。按返回的 `action` 分支处理:

- `committed` — 已提交:用 `result`(成功/跳过条数、每条任务) + `draft`(草稿文本)直接汇报,本次只 1 次工具调用。
- `needs_review` — 有 `pending`(needs_semantic / **unmatched** 即 task=-1)或 `noWork`(resolved 缺 work):只对这些条目走下面的「自动汇总日志」,note 写齐 summary 后直接 `render` → 确认 → `commit`(**render 会自动本地重 plan**,note 后无需手动重跑 plan)。**下次可先跑 `/shine-worklog:prepare` 把日志汇总前置,本动作即变秒级**。
- `cooldown` — 距上次提交 < 30 分钟:告知用户需等待 `waitMinutes` 分钟。
- `nothing` — 全 already/skipped,无可提交:说明本次无需提交。
- `abort` — collect 失败(通常 daemon 未启动):提示用户启 daemon 或走分步 collect 排查。

> auto 只在「全 resolved」时自动提交;只要有一条 needs_semantic 或缺 work,就停在 `needs_review` 让 AI 处理——不会盲目提交归属未定的工时。

### 1. 选数据源 + plan(读缓存:summary + 工时 + 防重 + cooldown 预判)

先用 AskUserQuestion 问数据源(task/项目从哪取):
- **本地缓存(推荐)**——读 cache,秒级(`plan`,默认)
- **禅道实时**——plan 内联网刷新 cache,准(`plan --source zentao`,怀疑缓存滞后/新任务没进缓存时用)
- **先刷新缓存**——先 `refresh`(拉全部 + 进度 [1/4]...[4/4])再 `plan`(读刷新后 cache,适合 cache 明显过期)

选定后运行:
```
bun "<Base directory>/scripts/zentao.ts" plan [--source zentao]
```
(选"先刷新"则先跑 `bun "<Base directory>/scripts/zentao.ts" refresh`,再 plan)

一步读 `sessions.json`(Stop hook 每轮自动 collect 写入,范围=**自上次提交日以来**含今天,上限 14 天,**不需主动 collect**)+ summary + submitted,输出 `plan.json` + 返回 `cooldown`。**填报流程会话已自动聚合**:跑 /report//prepare//amend 产生的 skill 会话(识别:标题含 `skills\report|prepare|amend` 且活跃<45min)同日合并为一条「执行 shine-worklog 工时填报流程」,工时按时间区间并集去重——**AI 无需再手动合并同类条目**。按返回分三个分支:

- **`cooldown` 非空**(距上次提交<30min):告知用户"距上次提交需等 `waitMinutes` 分钟",**停止,不 render/commit**。
- **全 `already`**(已提交且增量<15min):无需提交,render 空草稿说明本次无需。
- **有 `resolved` 或 `needs_semantic`**:进第 2 步(自动汇总日志)。`resolved` = 分支名含任务号 / 已提交增量补报 / summary 记录(work+task 已就绪);`needs_semantic`(无 summary,附 candidates)走第 2 步读 transcript 自动归纳。

> 防 `work=null`:已提交会话的增量补报,work 优先取 summary 已有记录;若为 null,走第 2 步读 transcript 自动归纳写 plan.json。

### 2. 自动汇总日志(读 transcript 归纳 work+task)

对 `needs_semantic` / 缺 work 的会话,**先向用户输出一句「正在汇总日志...」**,然后自动读 transcript 归纳(不再依赖开发时记 note):

1. 跑 `bun "<Base directory>/scripts/zentao.ts" prepare` —— 拉取会话关键信号(daemon 后台预提取:每 turn 结论 + git commits + 任务清单 + 用户意图;老会话无预提取/daemon 不可达时退化 `transcript` 现场直读:最近汇报文本 + 用户要求 + 改动文件 + 工具计数)
2. 对每个 `pending` 条目,据 `signals`(优先)或 `transcript`(退化)归纳 work + 选 task:
   - **work**:`signals` 非空时以 `turns` 逐轮 `conclusion`(Claude 本轮结论汇报)为主料、`commits`/`taskSubjects` 佐证、`prompts` 补意图;`transcript` 非空时据 recentAssistantTexts + prompts + filesChanged;两者皆 null 时退化用 daemonSummary + filesChanged 推断。生成一句话核心成果(动宾,不罗列功能点)
   - **task**:从 candidates 选最匹配(置信度 ≥85 直定;<85 或候选模糊时用 AskUserQuestion 让用户选,≤4 选项,选项含「更新缓存后重新匹配 / 创建新任务 / 选候选 / 跳过」)
   - 调 `note --session <id> --work <生成的work> --task <task>` 写 summary
3. **⚠️ 全 resolved 时跳过归纳,直接 render**:auto-note 的 conclusion 本身就是每轮的总结句(质量已达「总结性 work」标准),**plan 返回的 work 是什么样就怎么提交**——不要为「把 work 归纳得更好」重新组织文案,更**严禁为此额外考古**(git log / 读文件 / 查环境:实测一次多花 90s 思考,零收益)。归纳只在用户明确要求「调整文案」时做。仅当 work 明显异常(join 拼接不连贯/流水账多行)时才按下面规则精简。

4. **work 异常的快修**(引导语/截断/拼接不连贯):**直接凭已知上下文用 Edit 改 plan.json 该条 work**——item 自带 `summary`(会话标题,即该会话干了什么的概括)+ 你对近期工作的了解,一句话写出实际成果即可。**禁止探查**(不跑 prepare、不读 summary 文件、不读源码、不查 git log——实测一通探查多花 2 分钟,信息量与 item.summary 相当)。改完 render → 确认。

5. **归纳规则**(仅在 work 异常或用户要求调整时):
   - 相似/相关功能**合并成一句话**;每条一句话核心成果(动宾),不加括号技术细节
   - **严禁小括号列技术细节**、**严禁逐条罗列(流水账)**,细节留 transcript

高置信度条目不打扰用户;不确定的归属问题在这一步用 AskUserQuestion 问完。

### 3. 草稿与确认

```
bun "<Base directory>/scripts/zentao.ts" render
```

渲染工时草稿纯文本(编号自动递增;计划中还有 `needs_semantic` 或缺 `work` 的条目会直接报错——这保证了草稿永远是问完归属之后、确认提交之前的最后一步)。

把 render 输出**原样**放进代码块展示给用户,随后立刻用 AskUserQuestion 请用户确认整批提交(提交 / 调整 / 取消)。**未经确认绝不 commit**。

- 用户要求调整(改归属/改工时/改文案/按比例拆分/剔除)→ 改 plan.json 对应字段 → 重新 render → 再确认。拆分 = 复制条目,同 session 不同 task,工时按比例分
- ⚠️ 改**已 resolved 条目**的 work 文案:**直接用 Edit 工具改 plan.json 对应条目的 work 字段**——render 只在还有 pending 时才重 plan,全 resolved 时直改不会被覆盖。**不要用 `note` 改文案**:note 是**追加**语义(会多出一条,plan 把新旧 join 成两行),只适合给缺素材的会话补记录;用内联脚本(bun -e)直改 plan.json 也要避免——JS 单引号里的 `\n` 是真换行,要字面 `\n` 须写 `\\n`
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
