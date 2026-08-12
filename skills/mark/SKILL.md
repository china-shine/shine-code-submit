---
name: mark
description: 配置禅道工时的 AI 提交标识(开关+文案):查看、开启/关闭、修改标识文案。提交时拼到工作内容末尾,日报/周报据此对账统计 AI 代报工时。当用户要求配置/查看/开关 AI 提交标识、改 AI 填报文案、AI 标记,或运行 /mark 时使用。
---

# AI 提交标识配置

AI 提交标识让 `/shine-worklog:report` 自动填报禅道工时时,在 work(工作内容)末尾追加一行标识(默认「本次内容由AI填报」)。标识随禅道 effort 走,`/daily` `/weekly` 据此对账统计「AI 代报 N h」。配置存 `settings.json` 的 `aiSubmitMark:{enabled,text}`,dashboard「设置」页的「AI 提交标识」区块配的是同一处。

脚本在 report skill:`<Base directory>/../report/scripts/zentao.ts`。**用绝对路径在当前项目目录下调用、不要 cd**(脚本靠 `process.cwd()` 识别项目)。

## 命令

```
bun "<Base directory>/../report/scripts/zentao.ts" mark --show              # 查看当前开关与文案
bun "<Base directory>/../report/scripts/zentao.ts" mark --on                # 开启(提交时拼标识)
bun "<Base directory>/../report/scripts/zentao.ts" mark --off               # 关闭(不拼标识)
bun "<Base directory>/../report/scripts/zentao.ts" mark --text "自定义文案"  # 改标识文案
```

不传改动参数(或仅 `--show`)只读;返回值恒为合并默认后的 `{ path, aiSubmitMark:{enabled,text} }`。

## 流程

1. 先 `mark --show` 展示当前配置(开关 + 文案)给用户。
2. 按用户意图执行 `--on` / `--off` / `--text "..."`,把返回的新配置展示给用户确认。
3. 提醒:改文案后,历史提交需按旧文案才能被 `/daily` `/weekly` 报表识别;dashboard「设置 → AI 提交标识」也能配同一处。

## 说明

- 标识格式:work 末尾追加 `\n` + 文案(独立一行)。`/daily` `/weekly` 渲染时自动剥掉标识行、不计入工作内容编号。
- 默认:enabled=true,text="本次内容由AI填报"。
- 三处入口(本命令、dashboard 设置页、直接改 settings.json)读写同一份 `aiSubmitMark`,任改其一其余读到的是同一值。
