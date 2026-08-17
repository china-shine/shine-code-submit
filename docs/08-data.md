# 08 数据与文件布局

[← 手册索引](README.md)

## 运行时数据(`%LOCALAPPDATA%/shine-worklog/`,代码里 `DATA_DIR`)

> 源码:`src/shared/paths.ts` 与 `skills/report/scripts/lib/shared.ts`(两处内联复刻,改动需同步)

```text
DATA_DIR/
├─ daemon.pid                 # {pid, port, token, startedAt}:进程标识 + Bearer 鉴权
├─ daemon.token               # 持久 token(重启/升级复用,dashboard 链接不失效)
├─ settings.json              # 行为开关:reportUrl/reportIntervalMin/autoUpdate/
│                             #   zentaoCacheTtlMin/aiSubmitMark 等(与 config.json 分离)
├─ db/events.sqlite           # daemon 主库:hook 事件(7 天滚动修剪)+ transcript 会话统计(见 05-daemon)
├─ log/daemon.log             # 运行日志(5MB 轮换)
├─ spool/                     # hook 发送失败的事件暂存(daemon 1s 回捞)
├─ signals/                   # ★transcript 关键信号(/report AI 填空素材,consumer 后台增量提取):
│  └─ <编码项目>/<日期>/<sessionId>.json
│                             #   turns(每轮结论/commits/任务/文件)+aiTitle+awaySummaries;
│                             #   日期=首个信号事件日(跨午夜会话留开工日目录);不入 SQLite,
│                             #   整目录可删——近 3 天活跃的会话由兜底全扫自动重建,更早的走直读兜底
├─ reports/                   # 日报/周报 HTML(日报-YYYY-MM-DD-<姓名>.html,同日覆盖)
└─ zenpilot/                  # 工时链路数据(原 ZenPilot 目录统一迁入)
   ├─ config.json             # 禅道连接(url/account/password)—— /setup 写
   ├─ cache.json              # 禅道元数据缓存:{fetchedAt,projects[],tasks[](仅未完成),
   │                          #   executions[],taskDetails{}}(不含 efforts,增长大头拆出)
   ├─ efforts/<taskId>.json   # 按任务拆分的工时记录(近 20 天滚动窗口,过期修剪)
   ├─ mappings.json           # 仓库→项目 / 分支→任务 映射(提交时学习)
   ├─ submitted/<date>.jsonl  # ★提交流水逐笔 append-only(行号即 subId=<date>:<行号>),
   │                          #   daemon 据此上报 tokenserver 镜像禅道,幂等重放
   └─ projects/<编码cwd>/     # 按项目隔离(cwd 非字母数字→"-",对齐 Claude Code 编码)
      ├─ sessions.json        # 当日会话(Stop hook collect 写,daemon /api/sessions 供数)
      ├─ summary-<date>.json  # note 记录的 work+task(带 notedActiveMinutes 水位)
      ├─ plan.json            # /report 草稿(draftSeq 同日递增、跨日归零)
      └─ submitted.json       # 防重水位:{date:{session:{tasks,hours,minutes,_meta.lastCommit}}}
```

## tokenserver 数据(`tokenserver/data/tokens.db`,生产同构)

```text
sessions     (sessionId 单列 PK)             # 会话:Token 四项/activeMs/行数/标题
                                              # (多机同名 sessionId 会互相覆盖,当前单人单机无碍)
projects     (gitUser,cwd)                    # 项目名/gitRemote
git_changes  (hash 全局 PK)                   # 每 commit:added/deleted/aiAdded/aiDeleted
                                              # ★hash 全局主键 → 同 commit 多 cwd 上报天然去重
worklogs     (gitUser,date,sessionId,taskId,subId PK)
                                              # 禅道工时逐笔镜像,subId 来自提交流水行号
```

## 关键口径

| 数据 | 口径 | 出处 |
|---|---|---|
| 工时(activeMs) | 与 Claude 对话活跃度:1h gap 切段 + 每段 10min buffer + 单点 10min | transcript 时间戳(非 git) |
| 汇报工时 | `hoursFromMinutes`:向上取 0.5h,最小 0.5h | shared.ts |
| 增量阈值 | 会话增量 ≥15min 才补报;两次 commit 冷却 30min | zentao.ts |
| AI 代码行 | commit 的 added/deleted 行与「AI 编辑过的行集合」交集(集合已滤空行/纯括号) | daemon lines.ts + aggregate |
| AI 代报工时 | 禅道 work 末尾含「(本次内容由AI填报)」标识的记录 | isAiWork |

## 备份/迁移要点

- 换机迁移:拷贝整个 `DATA_DIR/`(config.json 含禅道密码,注意保密);
- events.sqlite 可删(daemon 会重建重扫,历史 transcript 全量回扫耗时 10-30s);
- tokenserver 侧 worklogs **只增不删**——禅道侧删改的记录在平台永久残留(已知设计缺口)。
