# 09 HTTP API 参考

[← 手册索引](README.md)

## daemon(默认 bind 0.0.0.0:36666,hook 走 127.0.0.1)

鉴权:`Authorization: Bearer <token>`(token=DATA_DIR/daemon.token 持久化值,普通字符串比较);WS 用 `?t=`。**免鉴权**:`/api/health`、`/` 与 `/ui/*` 静态页、`/favicon.ico`;reports 预览走 `?t=<token>` query。

### 业务数据

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/health | {service,pid,version,uptime};service 必须 === "shine-worklog"(探活认自己人) |
| GET | /api/stats | 统计窗口聚合(dashboard 概览) |
| GET | /api/events | hook 事件分页(dashboard 调试;cwd/type/since 过滤;仅近 7 天,超出被滚动修剪) |
| GET | /api/transcript?session= | 会话 transcript 明细(dashboard 会话详情) |
| GET | /api/commits | 提交列表(dashboard) |
| GET | /api/sessions | `?since=<ms>`(全部会话 limit 10000)或 `?cwd=<path>`(项目会话分页富化) |
| GET | /api/signals | `?cwd=<path>`(必填)+`&since=<ms>`/`&sessionId=<id>`:transcript 关键信号(/report AI 填空素材)。读 `DATA_DIR/signals` 文件不查 SQLite;返回 `{sessions:[{sessionId,turns[{conclusion,prompts,commits,taskSubjects,files,added,removed,skills}],commits,taskSubjects,filesChanged,toolUseCounts,awaySummaries,aiTitle,...}]}`(上限 200 会话,按 lastAt 取最近;同 sessionId 双文件取新鲜者);老会话未提取→查不到,调用方退化直读 transcript |
| GET | /api/projects | 项目列表(L1 分页) |
| GET | /api/report | `?since=` 自构建报表(上报同源,调试用) |

### 配置与控制

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/PUT | /api/settings | settings.json(reportUrl/reportIntervalMin/zentaoCacheTtlMin/autoUpdate/aiSubmitMark...) |
| GET/PUT | /api/zentao-config | 禅道连接(url/account/password) |
| GET | /api/zentao-cache | 禅道缓存内容 |
| POST | /api/zentao-cache/refresh | spawn zentao.ts refresh;in-flight 锁;120s 超时 |
| GET | /api/skills | skills 下的 Markdown 列表(当前生效插件根 skills/:相对路径/大小/mtime/edited/useCount)+ 版本 + sourceMode + `stale`(本地编辑与磁盘不一致,可能被升级覆盖);仅 `.md`,代码文件不开放;**按近 7 天 `shine-worklog:<name>` 使用次数降序**(源=UserPromptSubmit.prompt 文本,高频靠左),同频按字母序 |
| GET | /api/skills/file | `?path=<rel>`:读单文件内容;路径两道校验(段白名单+前缀防穿越),仅 `.md`,≤1MB |
| PUT | /api/skills/file | `{path,content,baseMtimeMs?}`:先备份到 `DATA_DIR/skills-edits/` 再原子写——skill 文件命令触发时从磁盘读,**保存即生效**;备份含首次编辑前 `original` 基线(供 reset);baseMtimeMs 护栏(编辑期间被改→409,确认后去掉重发覆盖) |
| POST | /api/skills/restore | `{path,version?}`:把备份内容写回磁盘(默认该文件最新备份),恢复也落新备份 → 退出 stale |
| POST | /api/skills/reset | `{path}`:把文件恢复到首次编辑前的原始内容(备份 `original` 字段),重置可反复用;无备份→400 |
| POST | /api/skills/open-backup | 在系统文件管理器打开备份目录 `DATA_DIR/skills-edits/`(不存在先创建;Win: explorer / mac: open / linux: xdg-open),返回 `{ok,path}` |
| POST | /api/report/upload | 手动上报;`?full=1` 全量;失败 {status:"skipped"} 水位不推进 |
| POST | /api/update | 手动检查更新(dashboard 按钮) |
| POST | /api/hook/<type> | hook 事件入口(响应含 version 供版本同步) |
| POST | /api/shutdown | 优雅停止 |

### 报表与 UI

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/reports/daily、/api/reports/weekly | 报表文件列表(dashboard 模块,含批量删除/下载) |
| GET | /reports/daily/&lt;date&gt;、/reports/weekly/&lt;range&gt; | 报表 HTML 预览(`?t=` 鉴权) |
| GET | /(= /ui) | dashboard(React SPA) |
| WS | /api/ws?t= | 实时事件推送(前端 2s 自动重连) |

## tokenserver(0.0.0.0:36667,⚠️ 全接口无鉴权)

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/health | {ok,ts} |
| POST | /api/report | daemon 上报(gzip 自动解码;upsert 幂等;256MB body 上限) |
| GET | /api/stats | `?start=&end=`(**YYYY-MM-DD**,内部转 ms)+ members 过滤;totals/members/daily/sizeBuckets |
| GET | /api/sessions | `?start=&end=`(YYYY-MM-DD)+ member/members/分页 |
| GET | /api/denominator-breakdown | AI 占比分母构成:byCwd + byAi(ai/no-ai 桶) |
| GET | /api/member/:gitUser | 单成员 KPI+趋势(granularity=day/week/month,`?start=&end=`) |
| GET | /api/member/:gitUser/worklog | 禅道工时表分页(`?start=&end=&page=&pageSize=`,rows/total/totalHours) |
| GET | / | 效能平台 UI |

## 禅道 REST v1(client.ts 封装)

`POST /tokens` 登录 → Token 头。用到的端点:`/projects?involved=1`、`/projects/<id>/executions`、`/executions/<id>/tasks`、`/tasks/<id>/estimate`(GET efforts / POST 提交,新请求体失败自动降级 <20.7 legacy)、`/tasks/<id>`、`/executions/<id>/tasks`(建任务)、`/user`。
