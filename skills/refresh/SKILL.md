---
name: refresh
description: 刷新禅道缓存——从禅道拉取全部项目、未完成任务及每个任务的工时记录,全量覆盖本地缓存。当用户要求刷新缓存、更新禅道数据、同步最新任务,或运行 /refresh 时使用。
---

# shine-worklog 刷新禅道缓存

从禅道拉取全部数据**全量覆盖**本地缓存:
- `cache.json`:项目 + 未完成任务(doing/wait) + 执行(元数据,稳定小)
- `efforts/<taskId>.json`:每个未完成任务的历史工时记录(每天 consumed + work),按任务拆分

> **调用约定**:脚本 = `<Base directory>/../report/scripts/zentao.ts`(**绝对路径、当前项目目录下调用、不要 cd**)。脚本靠 `process.cwd()` 识别项目。

## 流程

### 1. 刷新

```
bun "<Base directory>/../report/scripts/zentao.ts" refresh
```

联网拉取(约 5-10 秒),分步进度打到 stderr:
```
[1/4] 拉项目...
[2/4] 拉未完成任务(N 项目)...
[3/4] 拉工时记录(N 任务,并行)...
[4/4] 拉执行 + 写本地缓存...
```
完成后 stdout 输出 JSON:`{ fetchedAt, projects, tasks, executions }`。

> 进度走 stderr(Bash 工具能实时看到);JSON 走 stdout(机器解析)。如果用户通过 CLI 跑(`shine-worklog refresh`),进度实时透传给终端。

### 2. 汇报

把结果告诉用户:「✓ 缓存已更新到 `fetchedAt`,N 项目 / N 任务 / N 执行」。

## 何时用

- 禅道新增了项目/任务,本地还没同步(`/report` 匹配不到新任务时)
- 缓存可能过期(很久没刷新)
- 想强制全量刷新(覆盖本地旧数据)

## 注意

- `/report` `/daily` `/weekly` 默认**读本地缓存**(秒级),cache 后台定时刷新(`zentaoCacheTtlMin`,默认 300 分钟)。本命令是**手动强制全量刷新**(不等 TTL)。
- 刷新范围:只拉 setup 配的 projectIds(「属于自己的项目」)+ 未完成任务(doing/wait),已完成的任务不拉(不会提交工时)。
- 刷新是**全量覆盖**(拉禅道最新 → 覆盖本地,不留旧数据)。
- 禅道连接信息在 `~/.zenpilot/config.json`,未配置时 refresh 会报配置错(先 `/shine-worklog:setup`)。
