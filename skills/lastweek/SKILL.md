---
name: lastweek
description: 生成上周(周一~周日)的工时周报(从禅道提交记录 efforts 汇总),输出 HTML 到 reports/,含 AI 周总结。Use when 用户要求生成上周周报、上周工时总结、回顾上周,或运行 /lastweek。
---

# ZenPilot 上周周报

生成**上周(周一至周日)**的工时周报,数据来自禅道的提交记录(`/tasks/{id}/estimate` 的 efforts,非本地会话)。脚本自动算上周一~上周日区间,无需手填日期。输出为**自包含 HTML**,写入 `DATA_DIR/reports/周报-YYYY-MM-DD~YYYY-MM-DD-<姓名>.html`(上周重跑覆盖,不堆积;**dashboard 周报模块可查看**),并在底部附 **AI 周总结**。

脚本在 report skill:`<Base directory>/../report/scripts/zentao.ts`。仍用绝对路径调用、不要 cd;脚本写入 `DATA_DIR/reports/`(不依赖 cwd)。

## 流程

1. 运行:
   ```
   bun "<Base directory>/../report/scripts/zentao.ts" lastweek
   ```
   自动算上周一~上周日区间,stdout 是 JSON:`{ ok, file, title, empty, text }`。
2. **生成 AI 周总结**(若 `empty: true` 跳过本步):**先分析再提炼,不要复述表格已有的工作内容**。写三块:
   - **上周重心**:一句话判断主线/阶段(如"工具链建设为主""某模块收尾"),可带关键占比
   - **重点产出**:归纳上周核心成果(≤5 条,每条一句话,不带括号技术细节)
   - **下周计划**:**据 stdout JSON 的 `pendingTasks`(禅道所有未完成任务,数据驱动)**列下周要推进的任务——每条带任务名 + 剩余工时 `left` + 完成度 `consumed/estimate`,据完成度判断优先级;**严禁主观编造,只列 pendingTasks 里的真实未完成任务**(如「#78363 dify 环境 剩余 92.5h、完成 7.5/100 → 收尾交付」)
   
   关键:每条带**判断 / 数字**,不要把表格内容换个说法重述。
   
   把总结写入 HTML:先 Read 该 HTML 文件,再用 Edit 将其中的 `<!--AI_SUMMARY-->` 占位替换为(区块样式已内置):
   ```
       <section class="ai-summary">
         <h2>AI 周总结</h2>
         <p>上周汇总……</p>
         <h3>重点产出</h3><ul><li>……</li></ul>
         <h3>下周计划</h3><ul><li>……(据 pendingTasks)……</li></ul>
       </section>
   ```
3. 把 `text`(精简纯文本摘要)**放进代码块**展示给用户,并告知 **HTML 文件路径** + **dashboard 链接**(打开 dashboard 左侧「周报」模块查看;Windows 也可 `start <file>` 直接打开 HTML),说明底部含 AI 周总结。
4. 询问是否要调整文案/格式;若 `empty: true`(上周没有禅道提交记录),提示上周还没提交工时。

## 内容

周报表格列:**任务(#ID,可点击跳禅道任务页) | 日期 | 工时 | 工作内容**;同一任务跨多天用 `rowspan` 合并;表尾「上周合计」;底部「AI 周总结」区块。

> 数据按「指派给我 + 未删除 + 日期 ∈ [上周一, 上周日]」过滤;跨所有项目聚合。`lastweek` 等价于 `weekly --from <上周一> --to <上周日>`,只是自动算日期。
