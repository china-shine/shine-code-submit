---
name: mappings
description: 查看与维护 ZenPilot 的仓库→禅道项目映射缓存:列出、新增、修改、删除。Use when 用户要求查看映射、修改映射、删除映射、纠正某个仓库的工时归属项目,或运行 /mappings。
---

# ZenPilot 映射维护

仓库→项目映射决定工时填报时会话候选任务的收窄范围。脚本在 report skill:`<Base directory>/../report/scripts/zentao.ts`。**用绝对路径在当前项目目录下调用、不要 cd**。映射存于 `~/.zenpilot/mappings.json`(全局)。

数据存于 `../report/data/mappings.json`,当前只使用 `repoToProject`(仓库名 → 禅道项目 ID);分支→任务映射暂不启用。`projectNames` 是项目名的本地缓存,由 `plan`/`commit` 自动刷新。

## 操作

| 意图 | 命令 | 是否请求禅道 |
|---|---|---|
| 查看全部 | `bun "<Base directory>/../report/scripts/zentao.ts" mappings` | 否(项目名走本地缓存,秒回) |
| 新增/修改 | `bun "<Base directory>/../report/scripts/zentao.ts" learn --repo <仓库> --project <项目ID>` | 否 |
| 删除 | `bun "<Base directory>/../report/scripts/zentao.ts" mappings --forget-repo <仓库>` | 否 |
| 按项目名查 ID | `bun "<Base directory>/../report/scripts/zentao.ts" projects` | 是(仅在用户报的是项目名而非 ID 时才用) |

同 key 重复 learn 即覆盖,无需先删除。

## 流程

1. 查看命令输出已带 `projectName`(本地缓存),直接用表格展示:仓库 | 项目ID | 项目名。**不要**为了翻译名称去调 `projects` 或 `my-tasks`
2. 按用户的自然语言意图执行对应命令:
   - 「xx 仓库归到 yy 项目」:用户给项目名时才调 `projects` 查 ID,多个候选用 AskUserQuestion 确认
   - 「删掉/忘掉 xx 的映射」:删除前展示该条目让用户确认
3. 改动后重新执行查看命令,输出最新映射表

## 注意

- 修改立即生效,下次 `/report` 的 `plan` 直接读取
- 映射只影响自动归属判断,不会改动禅道上已提交的工时
- `/report` 流程中 `commit` 成功后会自动学习本次确认的 仓库→项目 映射
- 缓存里没有名称的项目(显示 null)属正常,跑一次 `plan` 或 `projects` 后即会补全
