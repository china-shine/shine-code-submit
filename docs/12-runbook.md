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

1. `/api/member/%` 非法编码 500(decodeURIComponent 未捕获);
2. sessions 列表 LIMIT 500 截断、getSessionLines 2000 条截断(长会话 lines 少算);
3. worklogs 只增不删;collect 全量快照范围=自上次提交日以来(≤14 天),防重靠跨日期水位(跨午夜/漏报补报均兼容);
4. daemon transcript 全量回扫历史会话补 aiAdded(一次性,~10-30s)。

> 已修待办:大小写盘符/子目录 cwd 导致 aiLines 查空、AI 占比被吃 ~40pp(2026-08-18:getProjectAILines 不再按事件 cwd 精确等值,改 file_path 落在项目内判定);tokenserver 鉴权(2026-08-19:POST HMAC 验签 + GET viewToken + reportUrl 默认空,见 docs/07「鉴权」)。

## 测试资产

- `skills/report/scripts/__tests__/`:262 用例(plan 增量/水位/拆段/多天补报/元会话聚合/增量 work 合并、commit 流水/numberWork、mark 幂等、client REST——含 **2xx 非 JSON rethrow 不 legacy 重发防双写**、auto-note 归纳/水位/节流/垃圾文案过滤/窗口全量 join、**auto 排除填报会话**);
- runner 子进程模式(plan-runner/commit-runner/attribution-runner):env LOCALAPPDATA 指临时目录真隔离(attribution-runner 所有本地时间运算在 runner 侧做,规避 bun test TZ=UTC 差 8h);
- `tokenserver/src/__tests__/server.test.ts`:38 用例(**HTTP 层全功能**,2026-08-21 新增;零测试→全覆盖)。真起服务(TOKENSERVER_DATA_DIR 临时目录 + PORT=0 随机端口),覆盖:health / HMAC 验签(x-report-ts 13 位 + ±15min 窗口 + gzip 先验签再解压 + 错签/错 ts/超窗 401 + 坏 JSON/缺 projects 400 + 幂等重放)/ viewToken 鉴权(?t= 与 Bearer、401 负例、豁免范围)/ stats 聚合(totals/trend/daily/composition/tokenRank/codeRank/sizeBuckets/members+version 取最新上报版本)/ denominator-breakdown(**host 白名单过滤**)/ sessions 分页(token>0 过滤)/ member 详情 + worklog 分页(totalHours + date 范围)/ 静态页 /docs / 配置热更新(删 viewToken 读接口开放、删 reportSecret 上报放行)。**不用 tsc**(基线噪音),验证靠 build:ui + HTTP。
- `scripts/verify-daemon-endpoints.ts`:**运行中 daemon 全端点验证**(2026-08-21 新增)。读 daemon.pid 拿 token,逐个打 40 项:鉴权豁免(health/静态/favicon)/ 鉴权负例(无 token/错 token/reports 无 ?t= 401)/ 全 GET 端点(stats/events/projects/sessions/signals/transcript/commits/report/zentao-config/settings/zentao-cache/skills 五端点/reports 列表与单文件)/ 安全写(zentao-config+settings 原样回写、hook 插无害事件);破坏性端点(shutdown/update/report-upload/refresh/DELETE/skills 写)盘点但不触发。改 daemon 路由后跑 `bun scripts/verify-daemon-endpoints.ts` 回归。
- 全量:`bun test` 17 文件 321 用例全绿(2026-08-21 实测)。

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
