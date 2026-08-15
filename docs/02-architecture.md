# 02 架构与数据流

## 全景图

```
┌───────────────────── 用户机(每台) ─────────────────────┐
│                                                          │
│  Claude Code                                             │
│   ├─ hooks(7 事件:SessionStart/UserPromptSubmit/        │
│   │        PostToolUse/Stop/SubagentStop/PreCompact/     │
│   │        SessionEnd)                                   │
│   │        │ POST /api/hook/<type>(Bearer pid token)     │
│   │        ▼                                              │
│   │   daemon(36666, src/)                                │
│   │    ├─ events.sqlite(事件与会话,transcript 增量挖掘)   │
│   │    ├─ 禅道缓存 zenpilot/cache.json + efforts/*.json    │
│   │    │   (20 天滚动窗口,TTL zentaoCacheTtlMin 默认 300min 自动刷 + in-flight 锁) │
│   │    ├─ dashboard UI(React,/ui?t=<token>)              │
│   │    └─ 上报循环(10min)─ gzip+增量 ──▶ tokenserver       │
│   │                                                      │
│   └─ skills(/report /daily /weekly ...)                  │
│        │ 调用                                             │
│        ▼                                                  │
│   skills/report/scripts/zentao.ts(命令集,零依赖)         │
│    ├─ 读 daemon /api/sessions(工时数字)                  │
│    ├─ 读 zenpilot/projects/<cwd>/(summary/plan/submitted)│
│    ├─ 提交 ── POST ──▶ 禅道 REST API v1                  │
│    └─ 提交流水逐笔落盘 zenpilot/submitted/<date>.jsonl    │
│            │(daemon collectWorklogs 读取上报)            │
└────────────┼─────────────────────────────────────────────┘
             ▼
┌──────────── tokenserver(36667,生产=linux 二进制) ──────────┐
│  POST /api/report(upsert 幂等) ──▶ tokens.db              │
│   ├─ sessions(会话)/ projects / git_changes(hash 全局 PK) │
│   ├─ worklogs(禅道工时镜像,主键含 subId 逐笔)             │
│   └─ AI 效能平台 UI:成员/项目榜/AI 占比/Token 趋势        │
└───────────────────────────────────────────────────────────┘
```

## 五条核心数据流

### ① 会话采集流(自动,无需用户操作)

```
Claude 写 transcript jsonl(~/.claude/projects/<编码>/<sid>.jsonl)
 → hook 各事件 POST 到 daemon(落 events 表 + spool 兜底)
 → daemon watcher 标 dirty → consumer 5s tick 增量读 jsonl 尾部
 → 全量计算该会话:activeMs(gap-aware)、Token 四项、代码行(Edit/Write patch)
 → events.sqlite transcript_sessions 表(接口读 SQLite 秒回)
```

### ② 工时提交流(/report,用户触发)

```
plan:读 sessions.json(Stop hook 写的当日会话)+ summary(note 记录)
     + submitted.json(防重水位)→ 产出 plan.json 草稿
 → 缺 work/task 的会话:prepare 读 transcript 信号 → AI 归纳 → note 写回
 → render(草稿文本)→ 用户确认 → commit
 → 禅道 API 逐条提交(work 带「(本次内容由AI填报)」标识、逐条编号)
 → recordSubmission 写水位;appendSubmittedLog 逐笔流水镜像
```

### ③ 禅道缓存流(refresh / TTL / 报表按需)

```
getCache(refresh?):项目(进行中+近20天有编辑)→ 执行(doing+近20天结束)
 → 任务(未完成全量+近20天完成)→ efforts(只留近20天记录)
 → cache.json(元数据)+ efforts/<taskId>.json(按任务拆分)
 → 修剪:窗口外任务文件删除、过期记录过滤、taskDetails 同窗
触发时机:①手动 /refresh ②daemon TTL(zentaoCacheTtlMin,默认 300min) ③报表 cache 源检测到
 缓存旧于最后一笔提交时自动先刷新再读(cacheStaleVsSubmissions)
```

### ④ 上报流(daemon→tokenserver,10min)

```
daemon buildReport(读 SQLite 聚合 + git log 带 AI 行匹配)
 → gzip POST /api/report(since=lastReportAt 增量;24h 全量校准)
 → tokenserver upsert(sessions 按 lastActive 新者胜;
    git_changes 按 hash 全局 PK 幂等;worklogs 按 (gitUser,date,sessionId,taskId,subId) 逐笔)
 → 失败不推进水位(数据不丢,下轮重试)
```

### ⑤ 自动升级流(autoUpdate)

```
daemon 定期查 npm registry latest → 有新版 → spawn detached
 `npx shine-worklog@latest install`(Windows 走 wscript VBS 静默)
 → install 部署新缓存目录 + hook 新于 daemon 时重启 daemon
 → 用户重启 Claude Code 后 hook 也更新
```

## 进程/模块边界(谁不依赖谁)

- skills(zentao.ts)**不依赖** daemon 运行——但工时数字读 daemon 接口(collect),daemon 不在则退化;
- daemon **不依赖** skills 运行,但禅道刷新是 spawn skills 的 zentao.ts(refresh);
- tokenserver 完全独立,只收 HTTP;
- hook 是纯转发器,daemon 不在时 ensureDaemon 自动拉起。

## 跨机/跨平台注意

- 所有日期比较用**本地时区日期串**(YYYY-MM-DD 字符串比较),不能用 toISOString(UTC);
- Windows:PowerShell 杀端口进程(git-bash taskkill 无效);spawn 子进程要 `detached:true`(node:child_process,Bun.spawn 无 detached 且 ignore stdio 会随父进程退出被杀——1.3.45/46 踩坑);
- 路径大小写:cwd 归一化比较用 normCwd(Windows toLowerCase),显示保留原样。
