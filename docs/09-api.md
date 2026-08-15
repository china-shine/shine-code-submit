# 09 HTTP API 参考

## daemon(127.0.0.1:36666)

鉴权:除 /api/health 外全部 `Authorization: Bearer <token>`(token 在 `DATA_DIR/daemon.pid` 的 token 字段,即 daemon.token 持久化值);WS 用 `?t=<token>`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/health | {service,pid,version,uptime};service 必须 === "shine-worklog"(探活认自己人) |
| POST | /api/hook/<type> | hook 事件入口(SessionStart/Stop/UserPromptSubmit/PostToolUse/SubagentStop);响应含 version |
| GET | /api/sessions | `?since=<ms>`(L1 全部会话,limit 10000)或 `?cwd=<path>`(L2 项目会话分页 `page/pageSize`,富化 title/activeMs/linesTotal) |
| GET | /api/report | `?since=` 自构建报表(上报同源数据,调试用) |
| GET | /api/projects | 项目列表(L1,`?since=&page=&pageSize=`) |
| GET | /api/settings | 读 settings.json |
| PUT | /api/settings | 改配置(reportUrl/reportIntervalMin/zentaoCacheTtlMin/autoUpdate/aiSubmitMark...) |
| GET | /api/zentao-cache | 禅道缓存内容(dashboard 禅道模块) |
| POST | /api/zentao-cache/refresh | spawn zentao.ts refresh;**in-flight 锁**,并发触发返回 {ok:false,"刷新进行中"};120s 超时 |
| POST | /api/report/upload | 手动上报;`?full=1` 全量;失败 {status:"skipped",reason}(水位不推进) |
| POST | /api/shutdown | 优雅停止(Bearer) |
| GET | /ui | dashboard(?t=token);静态资源同源 |
| WS | /api/ws?t= | 实时事件推送(dashboard 2s 自动重连) |

## tokenserver(0.0.0.0:36667,⚠️ 无鉴权)

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/health | {ok,ts} |
| POST | /api/report | daemon 上报(gzip 自动解码;upsert 幂等;256MB body 上限) |
| GET | /api/stats | `?from=&to=`(ms 时间戳)全局汇总:totals/members/daily/sizeBuckets |
| GET | /api/sessions | `?start=&end=`(YYYY-MM-DD)+members/member/分页 |
| GET | /api/denominator-breakdown | AI 占比分母构成:byCwd + byAi(ai/no-ai 两桶) |
| GET | /api/member/:gitUser | 单成员 KPI+趋势(granularity=day/week/month) |
| GET | /api/member/:gitUser/worklog | 禅道工时表分页(`?start=&end=&page=&pageSize=`,返回 rows/total/totalHours) |
| GET | / | 效能平台 UI |

## 禅道 REST v1(client.ts 封装)

`POST /tokens` 登录 → Token 头鉴权。用到的端点:`/projects?involved=1`、`/projects/<id>/executions`、`/executions/<id>/tasks`、`/tasks/<id>/estimate`(GET efforts / POST 提交,新请求体失败自动降级 <20.7 legacy)、`/tasks/<id>`、`/executions/<id>/tasks`(建任务)、`/user`。
