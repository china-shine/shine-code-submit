---
name: setup
description: 配置 ZenPilot 的禅道连接信息:服务器地址、账号、密码,验证连通性并让用户勾选常用项目。Use when 用户要求配置禅道、初始化 ZenPilot、修改禅道账号或服务器、设置常用项目,或运行 /setup。
---

# ZenPilot 禅道配置

配置写入 `~/.zenpilot/config.json`。脚本在 report skill:`<Base directory>/../report/scripts/zentao.ts`。**用绝对路径在当前项目目录下调用、不要 cd**(脚本靠 `process.cwd()` 识别项目)。

## 流程

### 1. 查看现状

运行 `bun "<Base directory>/../report/scripts/zentao.ts" config --show`。

- 已有完整配置:展示脱敏后的当前配置,用 AskUserQuestion 问用户想改什么(服务器/账号密码/常用项目/全部重配),只走对应步骤
- 无配置或缺字段(`missing` 非空):走完整流程

### 2. 收集连接信息

请用户在对话中提供:禅道服务器地址、账号、密码(缺哪个问哪个)。写入:

```
bun "<Base directory>/../report/scripts/zentao.ts" config --url <地址> --account <账号> --password <密码>
```

提醒用户:密码以明文存于本机 `~/.zenpilot/config.json`(权限 600),建议使用专用账号。

### 3. 验证连通

运行 `bun "<Base directory>/../report/scripts/zentao.ts" check`。

- 成功:向用户展示登录身份(姓名/角色)
- 失败:根据报错提示是地址不通还是账密错误,回到第 2 步重新收集,最多重试 3 次后停止并给出排查建议

### 4. 选择常用项目

运行 `bun "<Base directory>/../report/scripts/zentao.ts" projects` 拉取「我参与的进行中项目」(按最近活跃排序)。默认**一层过滤**:剔除任务全完成的(`left=0`),只保留还有剩余工时的(零额外请求、即时)。
列表长或要找特定项目时,用 `--search <关键词>` 按项目名筛(在这一层之上,子串、不区分大小写):
- `projects --search 医院` 在过滤结果里搜「医院」
- `projects --search 医院 --all` 在全部项目(含已完成)里搜,很快
- `projects --all` 看全部、不过滤

**展示与选择规范**(重要,务必遵守):
- 项目列表要在**回复正文**里用**单列编号列表**呈现,每行一条:`序号. [ID] 名称`。**不要**用宽表格(窄终端会换行/截断)、**不要**只贴 Bash 原始输出(终端会折叠成「+N lines」看不见)。
- 超过 50 条**分页**,每页 50,标注「第 X/Y 页」,提示可「下一页」或给关键词搜。
- AskUserQuestion 最多 4 项,装不下项目列表 → 让用户**报序号或 ID**(如「4」「3,4,15」)或**给关键词**(先 `projects --search <词>` 筛,再按规范展示筛后结果)。

确认选择后写入:

```
bun "<Base directory>/../report/scripts/zentao.ts" config --projects <逗号分隔ID>
```

常用项目决定 `/shine-worklog:report` 拉取候选任务的范围,选得准,归属判断越快越准。

### 5. 汇报

展示最终配置(密码脱敏),提示可以运行 `/shine-worklog:report` 开始填报。
