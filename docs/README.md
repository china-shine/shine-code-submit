# shine-worklog 开发手册

面向**接手开发/维护本项目的工程师**的完整文档(非用户使用说明,用户向见根目录 README.md)。
目标:读完本手册能独立理解架构、定位代码、安全地改功能、完成构建与发布。

## 阅读顺序(新人路线)

1. [01-overview.md](01-overview.md) — 项目是什么、三大件、技术栈
2. [02-architecture.md](02-architecture.md) — 架构图与端到端数据流(**最重要**)
3. [03-directory.md](03-directory.md) — 目录结构导览
4. [08-data.md](08-data.md) — 数据与文件布局(排障必读)
5. 按需深入子系统:[04-hooks](04-hooks.md) / [05-daemon](05-daemon.md) / [06-skills](06-skills.md) / [07-tokenserver](07-tokenserver.md)
6. [10-mechanisms.md](10-mechanisms.md) — 核心机制专题(工时算法/水位防重/缓存窗口/AI 占比)
7. [09-api.md](09-api.md) — HTTP API 参考
8. [11-build-release.md](11-build-release.md) — 构建、测试、发版、部署
9. [12-runbook.md](12-runbook.md) — 运维 FAQ 与交接清单

## 一页速览

```
Claude Code ──hooks──▶ daemon(36666) ──transcript 挖掘──▶ events.sqlite
   │                      │                                   │
   │ /report 等 skill     │ 禅道缓存(20 天滚动窗口)           │ 工时/Token/代码行
   ▼                      ▼                                   ▼
skills/report/scripts/zentao.ts ──提交──▶ 禅道(API)
   │                                        │
   └──提交流水镜像 submitted/*.jsonl ──daemon 上报──▶ tokenserver(36667)
                                                    ├─ 多机数据汇总(SQLite)
                                                    └─ AI 效能平台(UI)
```

- 语言/运行时:TypeScript + Bun(零 npm 运行时依赖,skills 层零依赖)
- 数据:本地 SQLite(events.sqlite / tokens.db)+ JSON 文件
- 前端:React(dashboard)/ 原生 HTML(报表,自包含无依赖)
- 发布:npm 纯源码包,daemon autoUpdate 自升级
