---
name: weekly
description: 生成本自然周(周一起)的工时周报(从禅道提交记录 efforts 汇总),输出 HTML 到 reports/,含 AI 周总结。Use when 用户要求生成周报、本周工时汇总、写周报,或运行 /weekly。
---

# ZenPilot 周报

生成**本自然周(周一至今天)**的工时周报,数据来自禅道的提交记录(`/tasks/{id}/estimate` 的 efforts,非本地会话)。输出为**自包含 HTML**,写入 `DATA_DIR/reports/周报-YYYY-MM-DD~YYYY-MM-DD.html`(本周重跑覆盖,不堆积;**dashboard 周报模块可查看**),并在底部附 **AI 周总结**。

脚本在 report skill:`<Base directory>/../report/scripts/zentao.ts`。仍用绝对路径调用、不要 cd;脚本写入 `DATA_DIR/reports/`(不依赖 cwd)。

## 流程

1. 运行:
   ```
   bun "<Base directory>/../report/scripts/zentao.ts" weekly
   ```
   stdout 是 JSON:`{ ok, file, title, empty, text, pendingTasks, dashboardUrl }`。
2. **先规范化表格 work,再生成 AI 周总结**(若 `empty: true` 跳过本步,直接第4步):
   
   **先规范化表格 work**:Read 该 HTML 文件,对每个任务的工作内容(`<details class="task">` 内)做**统一排版**后用 Edit 替换,固定标准(每次一致):序号多条「1. 2. 3. 」(单条不用)、每条一行 `。` 结尾;中文句子用全角标点(：。，；)、中英文/数字间加空格(如「Top K 降至 3~5」)、去连续冗余标点;引号统一 `""`、括号统一 `()`(技术参数内除外);**技术字符串原样不动**(`\n`、`Top K`、`1024` 等代码/参数/标识符不改);保留原意、保留有意义结构(【】小标题归组、内容重编号)、保留「(本次内容由AI填报)」标识、归并碎条。不同来源(AI 报/手填)work 风格不一,原样拼表显乱;只统一格式、不动内容与技术值。
   
   再**生成 AI 周总结**:**先分析再提炼,不要复述表格已有的工作内容**。写三块:
   - **本周重心**:一句话判断主线/阶段(如"工具链建设为主""某模块收尾"),可带关键占比
   - **重点产出**:归纳本周核心成果(≤5 条,每条一句话,不带括号技术细节)
   - **下周计划**:**据 stdout JSON 的 `pendingTasks`(禅道所有未完成任务,数据驱动)**列下周要推进的任务——每条直接说下周做什么(任务名 + 下周具体动作,如「继续迭代收尾」「服务器部署联调」「启动设计整理」「推进封装交付」);不要写 consumed/百分比/剩余 等数字,也不要「已过半/刚起步/工时最大块」等进度状态词;**严禁主观编造,只列 pendingTasks 里的真实未完成任务**(如「#78363 dify 环境 —— 服务器部署联调」)
   
   关键:每条直接说**下周做什么**(具体动作),不罗列数字、不写进度状态、不复述表格内容。
   
   把总结写入 HTML:先 Read 该 HTML 文件,再用 Edit 将其中的 `<!--AI_SUMMARY-->` 占位替换为(区块样式已内置):
   ```
       <section class="ai-summary">
         <h2>AI 周总结</h2>
         <p>本周汇总……</p>
         <h3>重点产出</h3><ul><li>……</li></ul>
         <h3>下周计划</h3><ul><li>……(据 pendingTasks)……</li></ul>
       </section>
   ```
3. 把 `text`(精简纯文本摘要)**放进代码块**展示给用户,并告知 **HTML 文件路径**(stdout 的 `file` 字段;Windows 可 `start <file>` 直接打开)+ **dashboard 链接**(stdout 的 `dashboardUrl` 字段,打开后点左侧「周报」模块查看;`dashboardUrl` 为 `null` 说明 daemon 未运行,此条略过、只给文件路径),说明底部含 AI 周总结。
4. 询问是否要调整文案/格式;若 `empty: true`(本周没有禅道提交记录),提示本周还没提交工时(先 `/shine-worklog:report`)后重跑。

## 内容

周报表格列:**任务(#ID,可点击跳禅道任务页) | 日期 | 工时 | 工作内容**;同一任务跨多天用 `rowspan` 合并;表尾「本周合计」;底部「AI 周总结」区块。

> 数据按「指派给我 + 未删除 + 日期 ∈ [本周一, 今天]」过滤;跨所有项目聚合。支持 `--from`/`--to` 指定历史区间(回看往周)。
