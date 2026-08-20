# shine-worklog skills 使用说明

6 个 skill,在 Claude Code 里 **`/shine-worklog:<name>`** 调用。也可以**直接说触发词**,Claude 按每个 skill 的「触发词」自动调起(不用手敲 slash)。每个 skill 内部按**执行逻辑**串起若干底层命令(`zentao.ts xxx`)。

> 数据根:`%LOCALAPPDATA%/shine-worklog/zenpilot/`。禅道工时只能追加。

---

## `/shine-worklog:setup` — 配置禅道

- **什么时候用**:首次配置 / 改禅道账号或服务器 / 重选常用项目
- **触发词**:`配置禅道`、`初始化`、`修改禅道账号`、`修改服务器`、`设置常用项目`

**执行逻辑**:
1. `config --show` — 先查现状(脱敏)
2. 缺字段 → `config --url --account --password` 补连接
3. `check` — 验证连通(失败回第 2 步,最多 3 次)
4. `projects` — 拉项目选常用(长用 `--search`,全用 `--all`)
5. `config --projects <ID,ID>` — 写常用项目

> 配置写入 `<DATA_DIR>/zenpilot/config.json`(密码明文,权限 600)。

---

## `/shine-worklog:report` — 填报工时(今天 + 上次提交以来未提交的)

- **什么时候用**:每天报工;漏报/增量也随时可跑
- **触发词**:`填报工时`、`上报工时`、`报工`、`提交禅道工时`

**执行逻辑**(顺序锁死):
1. `check` — 前置验证(失败 → `/setup`)
2. `collect` — 采集会话(自上次提交日以来含今天,回看上限 14 天;纯本地)
3. `plan` — 生成计划(条目 `resolved`/`needs_semantic`/`already`)
4. **AI 填空**(改 plan.json):
   - `needs_semantic` → 匹配 task(≥85 自定;<85 问用户;选「自动建任务」→ `executions`+`create-task`)
   - 任务找不到/过期 → `refresh` 重跑 plan
5. `render` — 草稿(有未决条目**报错拒绝**)
6. 用户确认(不确认不提交)
7. `commit` — 提交(<30 分钟冷却 → 转 `/amend`)

> 已提交会话又活跃 → 自动增量补报;work 按功能点编号。
> **auto-note**(1.3.50):每轮对话结束 Stop hook 后台自动把最新结论精简成 work+task 写 summary(零 LLM、无感、10min 节流;`settings.json` 的 `autoNote:false` 关)——`needs_semantic` 越来越少,`/report` 大多秒级。
> **元会话聚合**:跑 /report//prepare//amend 本身产生的会话同日自动合并为一条「执行工时填报流程」(时间区间并集去重,防填报工时自我繁殖与重复标题);**聚合条不计入工时**——报工时动作本身占用的时间不算工时(分步流程 SKILL 第 3 步删除该条目、auto 已内置排除)。

---

## `/shine-worklog:amend` — 修正最后一次提交

- **什么时候用**:报少了补 / 改上一笔(只处理最后一次,更早引导禅道页面)
- **触发词**:`修正最后一次提交`、`修改最后一次提交`、`上次报错了`、`报多了`、`报少了`、`补报工时`

**执行逻辑**:
1. 读 `submitted.json` 的 `_meta` → 展示最后一次提交

**A. 补工时**:改 plan → `render` → 确认 → `amend`(绕 30 分钟冷却,只认最后会话)
**B. 减工时/改文案**:`efforts --task` 列记录 ID → 引导禅道页面编辑 → 同步本地

---

## `/shine-worklog:daily` — 日报

- **什么时候用**:每天收工生成日报
- **触发词**:`生成日报`、`今天的工时汇总`、`写日报`

**执行逻辑**:
1. `daily` — 生成今天日报 HTML(禅道 efforts:今天);输出 `reports/日报-*.html`;没提交 → `empty:true` 提示 `/report`

---

## `/shine-worklog:weekly` — 周报

- **什么时候用**:每周生成周报
- **触发词**:`生成周报`、`本周工时汇总`、`写周报`

**执行逻辑**:
1. `weekly` — 生成本周(周一~今天)周报 HTML(禅道 efforts);输出 `reports/周报-*.html`(rowspan 合并);没提交 → 提示 `/report`

---

## `/shine-worklog:mappings` — 仓库→项目映射维护

- **什么时候用**:项目归属错了 / 新仓库指定归属 / 清理映射
- **触发词**:`查看映射`、`修改映射`、`删除映射`、`纠正仓库归属项目`

**执行逻辑**:
1. `mappings` — 查看全部
2. 按意图:
   - 新增/改 → `learn --repo --project`(给项目名先 `projects` 查 ID)
   - 删 → `mappings --forget-repo`(删前确认)
3. `mappings` — 再查确认

> 映射存 `<DATA_DIR>/zenpilot/mappings.json`,立即生效;`/report` 的 `commit` 也会自动学习。

---

## 速查

| 我想... | 调用 | 触发词(说这些也行) |
|---|---|---|
| 配禅道 / 改账号 | `/shine-worklog:setup` | 配置禅道、初始化、改账号、设常用项目 |
| 每天报工 | `/shine-worklog:report` | 填报工时、上报工时、报工、提交禅道工时 |
| 补工时 / 改上一笔 | `/shine-worklog:amend` | 修正最后一次、上次报错了、报多/报少、补报 |
| 今天的日报 | `/shine-worklog:daily` | 生成日报、今天工时汇总、写日报 |
| 本周的周报 | `/shine-worklog:weekly` | 生成周报、本周工时汇总、写周报 |
| 改仓库归属 | `/shine-worklog:mappings` | 查看/修改/删除映射、纠正归属 |

> **执行逻辑速查**(输入 slash → 调哪些底层命令):
> - `/setup`:`config --show`→(`config 写`)→`check`→`projects`→`config --projects`
> - `/report`:`check`→`collect`→`plan`→(按需 `executions`/`create-task`/`refresh`)→`render`→`commit`
> - `/amend`:读`_meta`→补:`render`+`amend` / 减:`efforts`
> - `/daily`:`daily` ／ `/weekly`:`weekly`
> - `/mappings`:`mappings`→(`learn`/`--forget-repo`)→`mappings`
