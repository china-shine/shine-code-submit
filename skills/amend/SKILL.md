---
name: amend
description: 修正最后一次禅道工时提交:查看最后一次提交内容、补报差额工时;减工时或改文案时引导到禅道页面并帮用户定位记录。当用户说 修正/修改最后一次提交、上次报错了、报多了/报少了、补报工时,或运行 /amend 时使用。
---

# shine-worklog 修正最后一次提交

脚本在 report skill:`<Base directory>/../report/scripts/zentao.ts`。**用绝对路径在当前项目目录下调用、不要 cd**——amend 改的 plan/submitted 按项目隔离在 `~/.zenpilot/projects/<编码项目路径>/`。

**硬约束**:禅道工时记录只能追加,不能减少或修改已提交的记录。所以"修正"分两条路:补工时走 `amend` 命令;减工时/改文案只能去禅道页面编辑。

> **为什么不能自动删改**:禅道 REST API v1 对工时(estimate)只暴露 `POST /tasks/{id}/estimate`(追加)和 `GET /tasks/{id}/estimate`(读取),**没有删除/修改端点**(源码路由表 `config/apiv1.php` 无 `/efforts` 路由;实测 `DELETE`/`PUT` 返回空 200 但修改不生效)。所以减工时/改文案**只能引导用户去禅道 Web 页面手动操作**,无法用 API 自动完成。

## 流程

### 1. 展示最后一次提交

读 `../report/data/submitted.json` 当天的 `_meta`:`lastCommit` 是最后一次提交的清单(会话/任务/工时),`lastCommitAt` 是时间。用表格展示给用户。没有 `_meta` 说明今天还没提交过,告知后停止。

### 2. 听取修正意图并分类

**A. 补工时(增加)**:

1. 改 `../report/data/plan.json` 对应会话条目:`status` 改回 `resolved`,`hours` 填补差值,`work` 写清是对上一笔的更正(如「补报:xxx」)
2. `bun "<Base directory>/../report/scripts/zentao.ts" render` 输出草稿给用户过目
3. AskUserQuestion 确认后执行:

   ```
   bun "<Base directory>/../report/scripts/zentao.ts" amend        # 支持 --dry-run
   ```

   amend 绕过 30 分钟提交冷却,但只接受最后一次提交包含的会话(脚本强制校验)。**未经确认绝不执行**

**B. 减工时 / 修改已提交的文案**:

1. `bun "<Base directory>/../report/scripts/zentao.ts" efforts --task <任务ID>` 列出该任务下我的工时记录(含记录 ID)
2. 引导用户到禅道页面编辑对应记录(告知记录 ID、日期、当前内容)
3. 用户改完后,把 `submitted.json` 里该会话的 `hours` 同步为改后的值,保持本地防重记录与禅道一致

### 3. 汇报

修正后的任务消耗/剩余工时、本地记录同步情况。

## 注意

- `amend` 成功后 `submitted.json`(累计工时与 `_meta`)由脚本自动更新,无需手工改
- 用户在 `/report` 的 commit 被冷却拦截、且明确表示想修正上一笔时,也转入本流程
- 只处理最后一次提交;更早的历史记录一律引导禅道页面编辑
