# 12 运维 FAQ 与交接清单

[← 手册索引](README.md)

## 排障速查

| 症状 | 根因 | 处置 |
|---|---|---|
| dashboard「连接中」/ token 一直变 | 残留 daemon 与 pid 文件不一致(health pid ≠ pid 文件 pid) | PowerShell 按端口杀 36666 → `bun run src/install/main.ts install --force` |
| collect 报 daemon 401 | 同上(token 不一致) | 同上 |
| health 报新版本但改动没生效 | version 运行时读 package.json 会伪装 | 验证重启看 **pid+uptime**;改 daemon 代码必须重启 |
| EADDRINUSE 36666 | 残留 bun 进程(git-bash taskkill 无效) | PowerShell `Get-NetTCPConnection -LocalPort 36666` → Stop-Process |
| 日报/周报「少了刚提交的一笔」 | 缓存旧于提交 | 1.3.46 起自动刷新;老版本选「先刷新缓存」或 `/refresh` |
| 报表缺已完成任务的工时 | 近 20 天内已并入聚合(taskDetails);仍缺 = 超 20 天窗口外/已关闭执行/不指派给我 | 用「禅道实时」源 |
| Windows curl 发中文变 GBK 污染 JSON | git-bash 编码 | 用 `bun -e fetch` 或 `curl -d @file.json` |
| bun -e 内联 JS 写文案出现真换行 | JS 单引号 `\n` 是转义 | 走 `note` 命令传参(bash 不转义)或写 `\\n` |
| 后台 spawn 的子进程不执行 | Bun.spawn + unref + ignore stdio 随父进程死 | 用 node:child_process 的 detached:true |
| 会话在 dashboard「凭空少一个」 | cwd 大小写/子目录变体 | normCwd 已合并大小写;子目录归属取最新 hook cwd(已知:会话里别 cd 子目录) |
| tokenserver 数据比禅道多 | worklogs 只增不删(设计缺口)+ 多机累积 | 对比 gitUser/cwd 判来源;禅道侧删改不会同步 |
| `/plugin` 显示旧版本 | marketplace path 指旧目录 | 重新 install(path 自动修正)或手改 settings.json 的 extraKnownMarketplaces |

## 遗留待办(接手者优先级)

1. **tokenserver 鉴权**(安全,记忆 tokenserver-auth-todo):全接口裸奔 + daemon 默认公网上报;方向=共享 token/限源/reportUrl 默认空;
2. `/api/member/%` 非法编码 500(decodeURIComponent 未捕获);
3. sessions 列表 LIMIT 500 截断、getSessionLines 2000 条截断(长会话 lines 少算);
4. 大小写盘符导致 aiLines 查空(罕见 hook 偶发);
5. worklogs 只增不删;collect 全量快照范围=自上次提交日以来(≤14 天),防重靠跨日期水位(跨午夜/漏报补报均兼容);
6. daemon transcript 全量回扫历史会话补 aiAdded(一次性,~10-30s)。

## 测试资产

- `skills/report/scripts/__tests__/`:135 用例(plan 增量/水位/拆段/多天补报、commit 流水/numberWork、mark 幂等、client REST);
- runner 子进程模式(plan-runner/commit-runner):env LOCALAPPDATA 指临时目录真隔离;
- tokenserver 功能测试:TOKENSERVER_DATA_DIR 指临时目录 + 造数据断言(store.ts 全链路);**不用 tsc**(基线噪音),验证靠 build:ui + HTTP。

## 交接清单(Checklist)

- [ ] 环境跑通:typecheck/test 全绿;源码起 daemon+tokenserver;dashboard 打开
- [ ] 凭据掌握:npm 账号 mecoding(Automation token);禅道测试账号;aliyun/github 推送权限;生产 tokenserver 机器
- [ ] 发版走通:CHANGELOG→bump 两处→publish.sh→tag→双远端→autoUpdate 验证
- [ ] 读完本手册 02(架构)/08(数据)/10(机制)三章
- [ ] 首个任务建议:tokenserver 鉴权(待办 #1,含生产部署)

## 维护本手册的惯例(防止文档漂移)

**总规则:项目的任何改动(不限下表类别——配置、流程、部署、行为变化、新增文件等)都要同步到本手册,与代码同 commit。** 下表是高频改动点的速查(经验:五轮核对抓出的漂移全在这些点):

| 改了什么 | 更新哪 |
|---|---|
| zentao.ts 新增/删命令 | 06 命令表(注意与 main() 的 cmd 分发保持全集一致) |
| daemon/tokenserver 新增端点 | 09 API 表 |
| hooks.json 事件 | 04 事件表 + 02 架构图 |
| 缓存窗口/阈值/冷却常量 | 08 口径表 + 10 对应机制 |
| 表结构/文件布局 | 08 |
| 发版流程变化 | 11 |
