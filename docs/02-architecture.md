# 02 架构与数据流

## 全景图

```mermaid
flowchart TB
    subgraph userMachine["用户机(每台)"]
        CC["Claude Code"]
        D["daemon :36666"]
        Z["zentao.ts<br/>(23 命令,零依赖)"]
        DB[("events.sqlite<br/>事件+会话(transcript 增量挖掘)")]
        ZC[("禅道缓存 cache.json + efforts/*.json<br/>20 天滚动窗口,TTL 默认 300min")]
        UI["dashboard UI<br/>/ui?t=token"]
        RD[("zenpilot/projects/&lt;cwd&gt;/<br/>summary / plan / submitted")]
        ZT["禅道 REST API v1"]
        SJ[("提交流水<br/>submitted/&lt;date&gt;.jsonl")]
        CC -->|"hooks 7 事件<br/>POST /api/hook(Bearer token)"| D
        CC -->|"skills 调用"| Z
        D --> DB
        D --> ZC
        D --> UI
        Z -->|"读 /api/sessions 工时数字"| D
        Z --> RD
        Z -->|"提交工时(逐条编号+AI 标识)"| ZT
        Z --> SJ
    end
    subgraph tokenServer["tokenserver :36667(生产 = linux 二进制)"]
        TS["POST /api/report<br/>(upsert 幂等)"]
        TDB[("tokens.db<br/>sessions / projects /<br/>git_changes(hash 全局 PK)<br/>worklogs(subId 逐笔)")]
        EFF["AI 效能平台 UI<br/>成员/项目榜/AI 占比/Token 趋势"]
        TS --> TDB --> EFF
    end
    D -->|"上报循环 10min<br/>gzip + 增量(since=lastReportAt)"| TS
    SJ -->|"daemon collectWorklogs 读取"| TS
```

> 原则:禅道是工时的**唯一事实源**(efforts),本地一切(sessions/plan/submitted)都是过程数据。

## 五条核心数据流

### ① 会话采集流(自动,无需用户操作)

```mermaid
flowchart LR
    A["Claude 写 transcript jsonl<br/>~/.claude/projects/&lt;编码&gt;/&lt;sid&gt;.jsonl"] --> B["hook 事件 POST daemon<br/>(events 表 + spool 兜底)"]
    B --> C["watcher 标 dirty<br/>(250ms debounce)"]
    C --> D["consumer 5s tick<br/>增量读 jsonl 尾部"]
    D --> E["全量重算会话:<br/>activeMs(gap-aware)/ Token 四项 / 代码行"]
    E --> F[("transcript_sessions 表<br/>(接口读 SQLite 秒回)")]
```

### ② 工时提交流(/report,用户触发)

```mermaid
flowchart TD
    A["plan:读 sessions.json + summary(note)<br/>+ submitted.json(防重水位)"] --> B{"有缺 work/task 的会话?"}
    B -->|是| C["prepare 读 transcript 信号<br/>→ AI 归纳 → note 写回"]
    B -->|否| D["render 草稿文本"]
    C --> D
    D --> E["用户确认"] --> F["commit:禅道 API 逐条提交<br/>(逐条编号 + AI 标识)"]
    F --> G["写防重水位 + 逐笔流水镜像<br/>submitted/&lt;date&gt;.jsonl"]
```

### ③ 禅道缓存流(refresh / TTL / 报表按需)

```mermaid
flowchart LR
    T{"触发"} -->|"手动 /refresh"| R["getCache(refresh)"]
    T -->|"daemon TTL(默认 300min)"| R
    T -->|"报表 cache 源检测到<br/>缓存旧于最后一笔提交"| R
    R --> A["项目(进行中+近20天有编辑)"] --> B["执行(doing+近20天结束)"]
    B --> C["任务(未完成全量+近20天完成)"] --> D["efforts 只留近20天记录"]
    D --> E["cache.json + efforts/&lt;taskId&gt;.json"]
    E --> F["修剪:窗口外文件删除<br/>过期记录过滤 / taskDetails 同窗"]
```

### ④ 上报流(daemon→tokenserver,10min)

```mermaid
flowchart LR
    A["daemon buildReport<br/>(SQLite 聚合 + git log AI 行匹配)"] -->|"gzip POST /api/report<br/>since=lastReportAt 增量(24h 全量校准)"| B["tokenserver upsert:<br/>sessions 按 lastActive 新者胜<br/>git_changes 按 hash<br/>worklogs 按 subId 逐笔"]
    B -->|失败| C["不推进水位(数据不丢,下轮重试)"]
```

### ⑤ 自动升级流(autoUpdate)

```mermaid
flowchart LR
    A["daemon 定期查 npm latest"] -->|有新版| B["spawn detached<br/>npx shine-worklog@latest install<br/>(Windows 走 wscript VBS 静默)"]
    B --> C["install 部署新缓存目录"]
    C -->|"hook 新于 daemon"| D["重启 daemon"]
    C -->|"用户重启 Claude Code"| E["hook 也更新"]
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
