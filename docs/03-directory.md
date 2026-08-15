# 03 目录结构导览

[← 手册索引](README.md)

```
livesetting/
├─ docs/                      # 本开发手册
├─ .claude-plugin/            # Claude Code 插件清单(marketplace.json/plugin.json,版本号在此!)
├─ hooks/hooks.json           # hook 定义:各事件 → node bin/launcher.cjs <事件>
├─ skills/                    # ★ Claude Code 插件层(slash 命令)
│  ├─ report/                 #   核心:/report + 脚本目录
│  │  └─ scripts/
│  │     ├─ zentao.ts         #   ★ 命令集入口(check/plan/note/render/commit/refresh/
│  │     │                    #     daily/weekly/lastweek/auto/mappings/... 共 23 个命令)
│  │     └─ lib/              #   shared.ts(路径+helpers)/ client.ts(禅道 REST+缓存层)/
│  │                          #   transcript.ts(collect)/ report.ts(报表渲染)
│  │     └─ __tests__/        #   bun:test 单测(plan/commit/mark/client)+ 子进程 runner
│  ├─ daily/ weekly/ lastweek/ refresh/ setup/ prepare/ amend/ mark/ mappings/
│  │                          #   各 skill 的 SKILL.md(AI 执行指令,改行为常改这里)
├─ src/                       # ★ daemon + hook + 安装器(TS,Bun 运行)
│  ├─ daemon/
│  │  ├─ main.ts              #   组装根:store/bus/spool/ws/watcher/consumer/server
│  │  ├─ server.ts            #   HTTP+WS API(/api/*)、上报 tick、autoUpdate tick、禅道刷新 tick
│  │  ├─ store.ts             #   events.sqlite 三表(events/transcript_files/transcript_sessions)
│  │  ├─ claude-scan.ts       #   transcript 目录发现与收集(纯工具)
│  │  ├─ transcript-consumer.ts #  核心:5s tick 增量读 jsonl 尾部→重算会话(工时/Token/行)
│  │  ├─ watcher.ts             #   fs.watch 只标 SQLite dirty(轻量,250ms debounce)
│  │  ├─ spool-consumer.ts    #   hook 漏发事件回捞(1s)
│  │  ├─ aggregate.ts         #   报表/列表共享聚合(cwd 分组 normCwd/token 汇总)
│  │  ├─ git.ts               #   git log 拉取(commits/AI commit 识别,quotepath=false)
│  │  ├─ lines.ts             #   代码行统计(patch 解析)+ AI 行集合(isTrivialLine 过滤)
│  │  ├─ worklog.ts           #   读提交流水 submitted/*.jsonl 供上报
│  │  └─ settings.ts          #   settings.json 读写
│  ├─ hook/main.ts            #   hook 入口:stdin 事件→POST daemon(失败 spool+ensureDaemon)
│  ├─ cli/main.ts             #   用户 CLI:status/start/stop/restart/ui/update/refresh
│  ├─ install/                #   安装器(npx 入口→dist/install.cjs):
│  │  ├─ main.ts              #     install/uninstall/status 分发
│  │  ├─ deploy.ts            #     白名单拷贝到 plugins cache + bun install + 版本目录管理
│  │  ├─ register.ts          #     注册三处 JSON(marketplace/installed/settings)
│  │  ├─ bun.ts               #     自动装 bun
│  │  └─ migrate.ts           #     1.3.0 改名一次性迁移(旧 daemon/数据/插件清理)
│  ├─ shared/                 #   三端共用九模块:config(常量)/paths(目录)/pidfile/daemonctl/
│  │                          #   updater(自动升级)/datetime(日期工具)/id(eventId 派生)/
│  │                          #   spool(事件暂存)/types(共享类型)
│  └─ daemon/ui-assets.ts     #   dashboard 前端内联产物(build:ui 生成,勿手改)
├─ ui/                        # dashboard 前端源码(React 19,Bun.build 打包)
│  ├─ app.tsx / index.html
│  ├─ components/             #   App/SideNav/各模块(Overview/Sessions/Report/Daily/Weekly/
│  │                          #   Settings/ZentaoCache/System)
│  ├─ hooks/ state/ lib/      #   useApi(带 Bearer)/useWebSocket(2s 重连)/聚合/格式化
├─ tokenserver/               # ★ 独立服务(生产=linux 单文件二进制)
│  ├─ src/{main,server,store,types}.ts
│  ├─ ui/                     #   效能平台前端(React,含 react-day-picker)
│  ├─ scripts/build.ts        #   打包:tailwind→bundle ui→ui-assets 内联→bun build --compile
│  ├─ data/                   #   运行时 tokens.db(gitignored)
│  └─ bin/tokenserver-linux-x64  # 打包产物(gitignored)
├─ scripts/                   # 构建/发布脚本(build.ts/build-ui.ts/build-install.ts/publish.sh)
├─ CHANGELOG.md               # ★ 发版必更,与 bump 同 commit
└─ package.json               # 版本(与 .claude-plugin/plugin.json 必须一致!)
```

## 改动定位速查

| 想改什么 | 去哪 |
|---|---|
| 禅道交互/提交/报表生成 | skills/report/scripts/(zentao.ts + lib/) |
| skill 行为(AI 执行步骤) | skills/*/SKILL.md |
| hook 采集/daemon API | src/hook/ src/daemon/server.ts |
| 工时算法 | src/daemon/transcript-consumer.ts(gap-aware 在此) |
| AI 代码占比 | src/daemon/{lines,git,aggregate}.ts + tokenserver/store.ts |
| dashboard | ui/(改后 build:ui + 重启) |
| 效能平台 | tokenserver/(改后重打包 linux 二进制) |
| 安装/升级 | src/install/ + src/shared/updater.ts |
