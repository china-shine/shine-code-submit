# shine-worklog skills 使用说明

6 个 skill,在 Claude Code 里 **`/shine-worklog:<name>`** 调用(或直接说需求,Claude 按触发词自动调)。每个 skill 内部按**执行逻辑**串起若干底层命令(`zentao.ts xxx`)。本文档讲清:敲了哪个 skill、什么情况下、按什么顺序调哪些底层命令。

> 数据根:`%LOCALAPPDATA%/shine-worklog/zenpilot/`。禅道工时只能追加。

---

## `/shine-worklog:setup` — 配置禅道

**什么时候用**:首次配置 / 改禅道账号或服务器 / 重选常用项目(触发词:配置禅道、初始化、改账号、设常用项目)

**执行逻辑**(按顺序):
1. `config --show` — **先查现状**(脱敏显示当前配置)
2. 若缺字段(`url`/`account`/`password`)→ `config --url <地址> --account <账号> --password <密码>` 补连接
3. `check` — **验证连通**(请求禅道 `/user`,失败回到第 2 步重收集,最多 3 次)
4. `projects` — **拉我参与的项目**选常用(列表长用 `--search <词>` 搜,看全部用 `--all`)
5. `config --projects <ID,ID>` — **写常用项目**(决定 `/report` 候选任务范围)

> 配置写入 `<DATA_DIR>/zenpilot/config.json`(密码明文,权限 600)。

---

## `/shine-worklog:report` — 填报当天工时

**什么时候用**:每天报工(触发词:填报工时、上报工时、报工、提交禅道工时)

**执行逻辑**(核心流程,顺序锁死):
1. `check` — **前置验证**禅道配置(失败 → 引导 `/setup`)
2. `collect` — **采集当天会话**(纯本地,读 daemon `/api/sessions` 写 sessions.json;hook 已自动采,此为兜底)
3. `plan` — **生成计划**(读 sessions/映射/防重,拉我的任务候选,输出 plan.json;条目标 `resolved`/`needs_semantic`/`already`)
4. **AI 填空**(不调命令,直接改 plan.json):
   - `needs_semantic` 条目 → 语义匹配 task(置信度 ≥85 自定;<85 列候选问用户)
   - 用户选「自动建任务」→ `executions` 拉执行 → `create-task --execution --name --estimate --desc` 建任务
   - 任务找不到/数据过期 → `refresh` 刷新缓存后**重跑 plan**
   - 给每个 `resolved` 条目生成 work 编号文案
5. `render` — **渲染草稿**(还有 `needs_semantic` 或缺 work 会**报错拒绝**,强制先问完归属)
6. 用户确认(提交/调整/取消;**未经确认绝不提交**)
7. `commit` — **提交禅道**(逐条 `submitEffort`,写防重 + 学映射)
   - ⚠️ 两次 commit <30 分钟 → **冷却拦截**,转 `/amend`

> 已提交会话又活跃 → plan 自动标增量补报。`work` 按功能点编号写。

---

## `/shine-worklog:amend` — 修正最后一次提交

**什么时候用**:报少了补 / 改上一笔(触发词:修正最后一次、上次报错了、报多/报少、补报)

**执行逻辑**(先展示最后一次提交,再按意图分两条路):
1. 读 `submitted.json` 的 `_meta`(`lastCommit`/`lastCommitAt`)→ 展示最后一次提交

**A. 补工时(增加)**:
2. 改 plan.json(status 改回 `resolved`,`hours` 填差额,work 写「补报:xxx」)
3. `render` — 渲染草稿给你过目
4. 确认 → `amend` — **补报**(**绕过 30 分钟冷却**,但只接受最后一次提交包含的会话)

**B. 减工时 / 改已提交文案**(禅道不能减/改,只能追加):
2. `efforts --task <ID>` — 列该任务下我的工时记录(拿到 `effortId`)
3. 引导你去禅道页面编辑对应记录 → 改完同步本地 `submitted.json`

> 只处理最后一次提交;更早的引导禅道页面。

---

## `/shine-worklog:daily` — 日报

**什么时候用**:每天收工生成日报(触发词:生成日报、今天工时汇总、写日报)

**执行逻辑**:
1. `daily` — **生成今天日报 HTML**(数据来自禅道 efforts:指派给我 + 未删除 + 日期=今天)
   - 输出 `reports/日报-YYYY-MM-DD.html`(表格 + AI 日总结占位),同日重跑覆盖
   - 当天没提交记录 → `empty:true`,提示先 `/report`

---

## `/shine-worklog:weekly` — 周报

**什么时候用**:每周生成周报(触发词:生成周报、本周工时汇总、写周报)

**执行逻辑**:
1. `weekly` — **生成本周(周一~今天)周报 HTML**(数据来自禅道 efforts)
   - 输出 `reports/周报-*.html`(表格 + rowspan 合并同任务跨天 + AI 周总结占位),本周重跑覆盖
   - 本周没提交 → `empty:true`,提示先 `/report`

---

## `/shine-worklog:mappings` — 仓库→项目映射维护

**什么时候用**:项目归属错了 / 新仓库指定归属 / 清理映射(触发词:查看/修改/删除映射、xx 归 yy、纠正归属)

**执行逻辑**(先查看,再按意图操作):
1. `mappings` — **查看全部映射**(带 projectName,本地缓存秒回)
2. 按用户意图:
   - **新增/修改** → `learn --repo <仓库> --project <项目ID>`(用户给项目名而非 ID 时,先 `projects` 查 ID)
   - **删除** → `mappings --forget-repo <仓库>`(删前展示条目确认)
3. `mappings` — 再查一次确认改动

> 映射存 `<DATA_DIR>/zenpilot/mappings.json`,立即生效;`/report` 的 `commit` 成功后也会自动学习。

---

## 执行逻辑速查(输入 slash → 调哪些底层命令)

| 输入 | 调用的底层命令(按执行顺序) |
|---|---|
| `/shine-worklog:setup` | `config --show` → (`config --url/account/password`) → `check` → `projects` → `config --projects` |
| `/shine-worklog:report` | `check` → `collect` → `plan` → (AI 填空;按需 `executions`/`create-task`/`refresh`) → `render` → `commit` |
| `/shine-worklog:amend` | 读 `_meta` → 补工时:`render`+`amend` / 减工时:`efforts --task` |
| `/shine-worklog:daily` | `daily` |
| `/shine-worklog:weekly` | `weekly` |
| `/shine-worklog:mappings` | `mappings` → (`learn` 或 `--forget-repo`) → `mappings` |

> 这些底层命令都被 skill 封装,**你只需敲 `/shine-worklog:*`**,skill 按上面的逻辑自动调。括号里的命令是按情况才调(缺配置/未匹配/要改/要删)。
