# 11 构建、测试、发布、部署

[← 手册索引](README.md)

## 日常开发循环

```bash
bun run typecheck          # tsc --noEmit(注意:skills/ 不在 tsconfig,签名改动要手动 grep 调用方)
bun test                   # 全部测试(263 用例/15 文件:skills CLI 端到端 + runner 深测 + src 含 src/cli/main.test.ts)
cd skills/report/scripts/__tests__ && bun test .   # 单跑 skills 层
bun run daemon             # 源码跑 daemon(36666)
bun run tokenserver/src/main.ts   # 源码跑 tokenserver(36667,数据在 tokenserver/data/)
```

本地改动的插件生效:`powershell` 杀 36666 → `bun run src/install/main.ts install --force`(⚠️ 不能 `npx shine-worklog install`——会装 npm 旧版)。hook 类改动需重启 Claude Code;ui 改动先 `bun run build:ui`。

## 构建(package.json scripts)

| 命令 | 产物 | 说明 |
|---|---|---|
| `bun run build` | bin/&lt;plat&gt;-&lt;arch&gt;/{hook,cli,daemon}.exe | bun build --compile 单文件;`--all` 交叉编译 6 平台 |
| `bun run build:ui` | src/daemon/ui-assets.ts | dashboard 前端内联(改 ui 必跑) |
| `bun run build:install` | dist/install.cjs | 安装器(CJS 零依赖,bun 未装时 node 也能跑;npx 入口) |
| `bun run build:dist` | ui + install.cjs | 发布所需(prepublishOnly 同) |
| tokenserver:`cd tokenserver && bun run scripts/build.ts` | tokenserver/bin/tokenserver-linux-x64 | tailwind→bundle UI→内联→compile(95MB) |

## 发布流程(npm,版本 N)

> 账号 mecoding(非 git 用户);登录验证必须 `npm whoami --registry=https://registry.npmjs.org/`(完整 URL);Automation token bypass 2FA。

1. **先更新 CHANGELOG.md**(两次发版漏过教训);
2. bump 版本:**package.json + .claude-plugin/plugin.json 两处**(1.1.0 漏过 plugin.json);
3. 同一 commit 提交(CHANGELOG+bump);
4. `bash scripts/publish.sh`(可带 OTP 参数):检查登录/工作区 → build:dist → npm pack → **python fix-tarball-mode.py 修 install.cjs +x 位**(Windows pack 不保留,Linux npx 会 Permission denied)→ publish;
5. **打 tag `v<N>` 推 aliyun + github(最易漏!)**;main 推双远端;
6. daemon autoUpdate 会在 1h 内自动把本机缓存升级到新版(验证看 plugins cache 出现新版本目录 + daemon health)。

推送注意:aliyun `git push aliyun main:master`(直连稳定);github `git push github main:main`(**必须显式 refspec**,push.default=upstream 会误推 master),直连波动先 `git ls-remote github` 试,不通查 Clash。

## 生产部署

- **tokenserver**(linux):`tokenserver/bin/tokenserver-linux-x64` scp 到生产机替换 → nohup 重启(口径类修复必须部署才生效,不部署不崩);
- **daemon**:无需手动部署——用户机 autoUpdate 自升级;
- **dashboard/效能平台**:分别随 daemon 二进制/tokenserver 二进制内联发布。

## 已知发布坑(都真踩过)

- npm 包纯源码无 exe;本地路径 install 会固化本地 build 的旧 exe 进缓存(现象:health 报旧版+日志每次 shutdown);
- npmmirror 同步延迟约 10 分钟(autoUpdate 拉 registry.npmjs.org 不受影响);
- tarball 可执行位必须修(见 publish.sh 第 5 步);
- CHANGELOG 与 bump 同 commit、tag 紧随——历史两次漏 CHANGELOG、多次漏推 tag。
