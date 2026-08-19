# 14 环境变量与配置清单

[← 手册索引](README.md)

## 环境变量

### 运行时(用户机)

| 变量 | 作用 | 默认 |
|---|---|---|
| `SHINE_WORKLOG_HOST`(旧前缀 `SHINE_CODE_SUBMIT_HOST` 兼容) | daemon 监听地址 | 0.0.0.0 |
| `SHINE_WORKLOG_DAEMON_CMD`(旧 `SHINE_CODE_SUBMIT_DAEMON_CMD`) | 完整 daemon 拉起命令(开发调试覆盖用) | — |
| `SHINE_WORKLOG_DAEMON`(旧 `SHINE_CODE_SUBMIT_DAEMON`) | bun run 入口覆盖 | — |
| `SHINE_WORKLOG_DEBUG`(旧 `SHINE_CODE_SUBMIT_DEBUG`) | 调试开关 | — |
| `SHINE_SILENT=1` / install `--silent` | 自动更新静默安装(日志落 install.log) | — |
| `CLAUDE_CONFIG_DIR` | Claude 配置目录(逗号分隔多目录;daemon 扫 transcript 用) | ~/.claude |
| `CLAUDE_PROJECT_DIR` | skills 脚本项目 cwd 识别回退 | — |

### 开发/测试

| 变量 | 作用 |
|---|---|
| `LOCALAPPDATA` | DATA_DIR 根(测试 runner 指向临时目录做隔离) |
| `TOKENSERVER_DATA_DIR` | tokenserver 数据目录(测试指向临时目录,不污染生产库) |
| `TOKENSERVER_REPORT_SECRET` / `TOKENSERVER_VIEW_TOKEN` | tokenserver 鉴权(优先于 config.json 同名字段;见 docs/07「鉴权」) |
| `PORT` | tokenserver 端口(默认 36667) |

## 配置文件

| 文件 | 写入方 | 内容 |
|---|---|---|
| `DATA_DIR/zenpilot/config.json` | /setup 或 `zentao.ts config` | 禅道连接 {url, account, password} |
| `DATA_DIR/settings.json` | daemon / dashboard 设置页 | 见下表 |
| `DATA_DIR/zenpilot/mappings.json` | 提交时自动学习 | repoToProject / branchToTask / projectNames |

### settings.json 字段(daemon 侧,PUT /api/settings 可改)

| 字段 | 默认 | 说明 |
|---|---|---|
| reportUrl | 空 | 上报目标地址(默认空=不上报;团队内部装完在设置页配,见 docs/07「鉴权」) |
| reportSecret | 随包默认分发 | 上报 HMAC 密钥,与 tokenserver 的 reportSecret 一致(服务端开验签时不一致恒 401 且不推水位不丢数据)。默认值随公开仓库可见(只挡顺手伪造);轮换 = 服务端改值 + settings.ts 换默认发新版;要真私密则清空默认各机单独配 |
| reportIntervalMin | 10 | 上报间隔 |
| autoUpdate / autoUpdateIntervalMin | true / 60 | 自动升级 |
| zentaoCacheTtlMin | 300 | 禅道缓存 TTL(本机常配 30) |
| aiSubmitMark | {enabled:true, text:"本次内容由AI填报"} | AI 提交标识 |
| lastReportAt / lastFullReportAt / lastDaemonVersion | — | 内部水位(勿手改) |

> ⚠️ 已知小坑:`shared.ts` 的 loadConfig 报错提示「参考项目根目录 config.example.json」,该文件实际不存在——按上表字段手工创建或走 /setup 即可。
