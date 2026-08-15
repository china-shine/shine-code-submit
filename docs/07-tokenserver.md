# 07 Tokenserver 子系统(tokenserver/)

独立部署的数据汇聚服务 + AI 效能平台。生产为 linux-x64 单文件二进制(`scripts/build.ts` 打包,95MB 内含 UI),开发模式 `bun run tokenserver/src/main.ts`(数据落 `tokenserver/data/`,gitignored)。

## 架构

```
POST /api/report(daemon 每 10min,gzip + since 增量)
 → saveReport(store.ts):幂等 upsert 三张表
   ├─ sessions:PK(gitUser,sessionId),WHERE excluded.lastActive >= 旧值 才更新(防过期全量回填回退)
   ├─ git_changes:PK(hash)★全局——同 commit 多 cwd 上报自动去重合并;aiAdded/aiDeleted 取 MAX
   └─ worklogs:PK(gitUser,date,sessionId,taskId,subId)——subId=提交流水行号,逐笔镜像禅道
 → GET /api/stats 等 → React UI(成员榜/项目榜/AI 占比/Token 趋势/禅道工时表)
```

## 关键实现(store.ts)

- **host 白名单**(aiStatsHosts 配置):`extractGitHost` 提取 remote 的 host 后**等值比较**(1.3.44 改;原 LIKE 子串会误命中 `my-github.company.cn`);无 remote/解析失败 → 排除;
- **AI 占比口径**:分子=行级匹配(aiAdded+aiDeleted),分母=commit added+deleted;只统计「有 transcript 覆盖(aiAdded/aiDeleted 任一>0)」的 commit(纯删除型 1.3.44 起不再丢弃);`getDenominatorBreakdown` 按 cwd/有无 AI 覆盖拆分(no-ai 桶 1.3.44 修复);
- **迁移**:worklogs 重建迁移单事务(rename→拷→drop→重建索引);残留 `worklogs_old` 表会让启动崩(罕见);
- **只增不删**:禅道侧删除/改小的记录在平台永久残留(已知设计缺口,全量上报无法收敛)。

## UI(tokenserver/ui/)

React 19 + tailwind(打包时编译内联)+ react-day-picker。页面:成员列表/成员详情(KPI+Token 构成+趋势+禅道工时表分页)/项目榜/AI 占比(含分母构成弹窗)/数据说明页(docs 渲染)。

## 打包与部署

```
cd tokenserver && bun run scripts/build.ts
# 0. tailwind css → 1. bundle ui → 2. 生成 src/ui-assets.ts(内联)→ 3. bun build --compile --target bun-linux-x64
# 产物 bin/tokenserver-linux-x64(gitignored)
```

生产部署:scp 到生产机替换 → nohup 重启。⚠️ daemon 侧新上报兼容旧二进制(extra 字段被忽略,不崩),但**占比口径修复需重新部署才生效**。

## ⚠️ 已知安全待办(见记忆 tokenserver-auth-todo)

全接口无鉴权绑 0.0.0.0(局域网可 GET 数据、可伪造 POST 覆盖);daemon 默认公网 10min 自动上报。修复方向:共享 token / 限源 / reportUrl 默认空。**接手者优先评估此项**。
