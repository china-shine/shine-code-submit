# 04 Hook 子系统(src/hook/)

[← 手册索引](README.md)

## 职责

Claude Code 生命周期的**轻量转发器**:stdin 读事件 → POST 给 daemon。自身不做业务,daemon 不在时自动拉起(ensureDaemon)。入口 `src/hook/main.ts`,由 `hooks/hooks.json` 声明(`node ${CLAUDE_PLUGIN_ROOT}/bin/launcher.cjs <事件>`)。

## 事件流

hooks.json 注册 **7 个事件**,统一走 `node ${CLAUDE_PLUGIN_ROOT}/bin/launcher.cjs <事件>`:

| 事件 | 转发外的主要动作 |
|---|---|
| SessionStart | ①清理旧版本缓存目录(保留最新 5 个,防多会话升级锁旧目录)②早采集 session(写 sessions.json,让第一轮 note 能读到)③startup/resume 时 stdout 输出 Dashboard 链接(systemMessage) |
| UserPromptSubmit | 转发(工时提醒 detectAndRemind 在 skill 层消费) |
| PostToolUse | 转发(dashboard 实时事件 + 代码行统计的数据源) |
| Stop / SubagentStop | detached fork `zentao.ts collect`(把**自上次提交日以来**的会话写 sessions.json 供 /report,上限 14 天——漏报/增量自动补) |
| PreCompact / SessionEnd | 转发(事件留存) |

```text
Claude Code 触发 hook(launcher.cjs 选平台二进制或 bun run 源码)
 → main.ts 读 stdin(JSON:session_id/cwd/payload)
 → postOnce:POST /api/hook/<type>,Authorization: Bearer <pid 文件 token>
   ├─ 成功 → 返回(顺带读响应 version 做 hook/daemon 版本同步判断)
   └─ 失败(含 4xx/5xx,不只网络异常)→ ensureDaemon(探活/拉起)
       → 重读 token 重试一次;仍失败 → 事件落 spool 目录(daemon 起来后 1s 回捞)
```

关键点:
- **postOnce 非 2xx 也算失败**(1.3.44 修):daemon 换 token 后旧 hook 得 401,曾被视为成功静默丢实时性——现在会走重试链路;
- **版本同步**(`forward`):仅当 **hook 版本 > daemon 版本**时 stopDaemon+spawnDaemon(把 daemon 升到 hook 版);反方向绝不动(会用旧 hook 降级新 daemon);
- Stop/SubagentStop 的 collect 是 **detached fork** 不阻塞;多 subagent 并发写 sessions.json 为原子写。

## spool 机制

POST 失败且重试失败 → 事件原样落 `DATA_DIR/spool/` 目录;daemon 的 SpoolConsumer 每 1s 扫描回捞。热路径(500ms 超时)永不阻塞 Claude Code。

## 修改注意

- hook 是用户机上**最先跑起来**的代码,必须零依赖、秒退;
- launcher.cjs 按平台选 `bin/<plat>-<arch>/hook.exe`,没有二进制则 `bun run src/hook/main.ts`(ensureBun 保证 bun 存在);
- 改 hook 后要重启 Claude Code 才生效(hook 按会话加载)。
