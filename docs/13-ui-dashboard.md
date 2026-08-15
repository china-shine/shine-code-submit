# 13 Dashboard 前端(ui/)

[← 手册索引](README.md)

daemon 自带的本地控制台(http://<ip>:36666/ui?t=<token>),React 19 + TypeScript,无路由库,Bun.build 打包。

## 结构

```
ui/
├─ index.html + app.tsx        # 入口:token 从 ?t= 取存 sessionStorage 后清 URL(无 token 显示提示)
├─ components/
│  ├─ App.tsx                  # AppProvider 包裹;ModuleRouter 按 activeModule 切模块
│  ├─ SideNav.tsx              # 一级导航:概览/会话/报表/日报/周报/设置/禅道/系统
│  └─ *Module.tsx              # Overview/Sessions/Report/DailyReport/WeeklyReport/
│                              # Settings/ZentaoCache/System(Events/Commits/Stats 已写暂屏蔽)
│  └─ 会话链:SessionsPanel→SessionDetail→Conversation/Message/ToolCard/DiffBlock
├─ state/AppContext.tsx        # 全局状态(useApi + useStatsPolling 轮询)
├─ hooks/                      # useApi(带 Bearer 的 fetch 封装)/useWebSocket(2s 自动重连)/
│                              # useEvents/useStatsPolling/useCommits/useConversation/useProjects/useSplitter
└─ lib/                        # aggregate(聚合)/diff(变更展示)/export(导出)/format/util
```

## 与 daemon 对接

- **HTTP**:`useApi` → `fetch(location.origin + path, {Authorization: "Bearer "+token})`(同源,daemon 直接服务静态资源);
- **实时**:`useWebSocket` → `ws(s)://host/api/ws?t=<token>`,断线 2s 重连,收 `{kind:"event",event}` 分发;
- **鉴权**:`/ui` 页面本身免鉴权,数据接口全部 Bearer(token 由 CLI/安装器拼进 `?t=` 链接)。

## 开发循环

```bash
bun run build:ui      # 打包 ui/app.tsx → 生成 src/daemon/ui-assets.ts(内联 INDEX_HTML/APP_JS/STYLE_CSS)
# 重启 daemon 生效(源码模式:杀 36666 → bun run src/daemon/main.ts 或 install --force)
```

⚠️ `src/daemon/ui-assets.ts` 是生成物勿手改;改 UI 只动 `ui/` 再 build:ui。

## tokenserver 的 UI(tokenserver/ui/)

独立一套效能平台前端:React 19 + **tailwind v4**(打包时编译)+ react-day-picker(日历)。页面:成员列表/成员详情(KPI、Token 构成、趋势、禅道工时表分页)/项目榜/AI 占比(分母构成弹窗)/数据说明页。打包:`cd tokenserver && bun run scripts/build.ts`(tailwind → bundle → 内联 ui-assets → compile linux)。
