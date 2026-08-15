# 01 项目概览

[← 手册索引](README.md)

shine-worklog(原名 shine-code-submit,1.3.0 合并 ZenPilot 更名)是一套 **Claude Code 工时自动填报与 AI 效能统计系统**。

## 它解决什么问题

团队用 Claude Code 写代码,需要回答三个问题:

1. **工时**:和 Claude 协作的时间怎么算、怎么报进禅道(项目管理)——自动挖掘会话活跃度、自动归纳工作内容、一键填报;
2. **AI 参与度**:哪些代码是 AI 写的、占多少——transcript 与 git commit 行级匹配,算出 AI 代码占比;
3. **多机汇总**:每个成员的 Token 用量/工时/AI 占比汇总成效能平台。

## 三大件

| 组件 | 端口 | 进程形态 | 职责 |
|---|---|---|---|
| **Claude Code 插件**(skills/) | — | Claude Code 宿主内 | 用户入口:`/report` `/daily` `/weekly` 等 skill;核心脚本 `zentao.ts`(禅道交互全在这) |
| **daemon**(src/) | 36666 | 常驻后台进程 | 会话数据中枢:hook 事件接收→SQLite;transcript 挖掘(工时/Token/代码行);dashboard UI 服务;禅道缓存 TTL 刷新;向 tokenserver 上报;autoUpdate 自升级 |
| **tokenserver**(tokenserver/) | 36667 | 独立部署(生产为 linux 单文件二进制) | 多机数据汇聚:接收 daemon 上报(gzip+增量),AI 效能平台 UI(成员/项目/AI 占比/禅道工时表) |

另有 **hook**(src/hook):Claude Code 生命周期的轻量转发器,是 daemon 的数据入口。

## 技术栈与约束

- **TypeScript + Bun**:全仓库统一;skills 层(`skills/report/scripts/`)**零 npm 依赖**(只 node: 内置),因为要在用户机上裸跑;
- **SQLite**:daemon 侧 `events.sqlite`(会话/事件),tokenserver 侧 `tokens.db`(上报汇总);
- **前端**:dashboard 为 React+Bun.build 打包内联进二进制;日报/周报为**自包含 HTML**(内联 CSS,零外部资源,离线可开);
- **发布形态**:npm 包**纯源码**(无二进制);用户机 install 时装 bun(若无)+ 源码运行;tokenserver 另有 linux-x64 单文件二进制(`tokenserver/bin/`);
- 版本:package.json 与 `.claude-plugin/plugin.json` 两处版本必须一致(1.1.0 曾漏改)。

## 关键设计原则(改代码前先读)

1. **工时口径 = 与 Claude 的对话活跃度**,不是代码量——纯沟通也累计,离开 Claude 的 gap 不计(详见 10-mechanisms);
2. **禅道是工时的唯一事实源**(efforts),本地一切(sessions/plan/submitted)都是过程数据,日报/周报只读禅道记录;
3. **提交流水逐笔镜像**(submitted/*.jsonl append-only)保证 tokenserver 侧与禅道逐字一致、幂等可重放;
4. **容错优先**:git 失败返回空、单任务拉取失败跳过、损坏 JSON 容错清理——采集链路任何一环坏了不能拖垮整体;
5. **原子写**(tmp+rename)所有多进程共写的 JSON(cache/sessions/submitted),读者永不读半截文件。
