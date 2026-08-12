---
name: daily
description: 生成今天的工时日报(从禅道提交记录汇总),输出 HTML 到 reports/,含 AI 日总结。当用户要求生成日报、今天的工时汇总、写日报,或运行 /daily 时使用。
---

# shine-worklog 日报

生成**今天**的工时日报,数据来自禅道的提交记录(`/tasks/{id}/estimate` 的 efforts,非本地会话),与禅道页面一致。输出为**自包含 HTML**,写入 `DATA_DIR/reports/日报-YYYY-MM-DD.html`(同日重跑覆盖,不堆积;**dashboard 日报模块可查看**),并在底部附 **AI 日总结**。

脚本在 report skill:`<Base directory>/../report/scripts/zentao.ts`。仍用绝对路径调用、不要 cd;脚本写入 `DATA_DIR/reports/`(不依赖 cwd)。

## 流程

1. 运行:
   ```
   bun "<Base directory>/../report/scripts/zentao.ts" daily
   ```
   stdout 是 JSON:`{ ok, file, title, empty, text, pendingTasks, dashboardUrl }`。
2. **先规范化表格 work,再生成 AI 日总结**(若 `empty: true` 跳过本步,直接第4步):
   
   **先规范化表格 work**:Read 该 HTML 文件,对每个任务的工作内容(`<details class="task">` 内)做**统一排版**后用 Edit 替换,固定标准(每次一致):序号多条「1. 2. 3. 」(单条不用)、每条一行 `。` 结尾;中文句子用全角标点(：。，；)、中英文/数字间加空格(如「Top K 降至 3~5」)、去连续冗余标点;引号统一 `""`、括号统一 `()`(技术参数内除外);**技术字符串原样不动**(`\n`、`Top K`、`1024` 等代码/参数/标识符不改);保留原意、保留有意义结构(【】小标题归组、内容重编号)、保留「(本次内容由AI填报)」标识、归并碎条。不同来源(AI 报/手填)work 风格不一,原样拼表显乱;只统一格式、不动内容与技术值。
   
   再**生成 AI 日总结**:**先分析再提炼,不要复述表格已有的工作内容**。只写两块:
   - **今日重心**:一句话判断今天的主线/节点
   - **明日计划**:只给具体工作方向(联调/验证/收尾),不要空话
   
   关键:每条带**判断 / 数字**,不要把表格内容换个说法重述。
   
   把总结写入 HTML:先 Read 该 HTML 文件,再用 Edit 将其中的 `<!--AI_SUMMARY-->` 占位替换为(区块样式已内置):
   ```
       <section class="ai-summary">
         <h2>AI 日总结</h2>
         <p>今日汇总……</p>
         <h3>重点产出</h3><ul><li>……</li></ul>
         <h3>明日计划</h3><ul><li>……</li></ul>
       </section>
   ```
3. 把 `text`(精简纯文本摘要)**放进代码块**展示给用户,并告知 **HTML 文件路径**(stdout 的 `file` 字段;Windows 可 `start <file>` 直接打开)+ **dashboard 链接**(stdout 的 `dashboardUrl` 字段,打开后点左侧「日报」模块查看;`dashboardUrl` 为 `null` 说明 daemon 未运行,此条略过、只给文件路径),说明底部含 AI 日总结。
4. 询问是否要调整文案/格式;若 `empty: true`(该范围内没有禅道提交记录),提示用户先 `/shine-worklog:report` 提交工时后重跑(覆盖同名文件)。

## 内容

日报表格列:**任务(#ID,可点击跳禅道任务页) | 工时 | 工作内容**;表尾「合计」;底部「AI 日总结」区块。

> 数据按「指派给我 + 未删除 + 日期=今天」过滤;跨所有项目聚合。支持 `--from`/`--to` 指定日期(回看某天)。
