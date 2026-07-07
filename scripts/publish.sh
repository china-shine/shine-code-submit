#!/usr/bin/env bash
# 发布 shine-code-submit 到 npm 官方 registry。
#
# 前置(只做一次):
#   1. npm login --registry=https://registry.npmjs.org/
#   2. npm 账号开 2FA(npmjs.com → Account Settings → Two-Factor Authentication)
#
# 用法:
#   bash scripts/publish.sh            # npm 交互提示输 OTP(推荐,OTP 不进命令历史)
#   bash scripts/publish.sh 123456     # 直接带 OTP(30秒有效,要快)
set -e

REGISTRY="https://registry.npmjs.org/"
OTP_ARG="${1:-}"

echo "=== 1. 检查 npm 官方登录 ==="
WHO=$(npm whoami --registry="$REGISTRY" 2>/dev/null | head -1)
if [ -z "$WHO" ]; then
  echo "✗ 未登录 npm 官方。请先跑:"
  echo "    npm login --registry=$REGISTRY"
  exit 1
fi
echo "✓ 登录账号: $WHO"

echo ""
echo "=== 2. 检查工作区(确保改动都提交了)==="
if [ -n "$(git status --porcelain)" ]; then
  echo "⚠️ 工作区有未提交改动:"
  git status --short
  read -r -p "仍然继续发布?(y/N) " C
  [ "$C" = "y" ] || { echo "已取消"; exit 1; }
fi

VERSION=$(node -p "require('./package.json').version")
TGZ="shine-code-submit-$VERSION.tgz"

echo ""
echo "=== 3. build:dist(生成 dist/install.cjs + ui-assets)==="
bun run build:dist

echo ""
echo "=== 4. npm pack ==="
rm -f "$TGZ"
npm pack

echo ""
echo "=== 5. 修 tarball 里 dist/install.cjs 的 +x 位(Windows npm pack 不保留可执行位)==="
echo "    不修的话 Linux 上 npx 经 .bin 符号链接+shebang 执行会 'Permission denied'。"
PY=""
for c in py python python3; do command -v "$c" >/dev/null 2>&1 && PY="$c" && break; done
if [ -z "$PY" ]; then echo "✗ 需要 python(tarfile stdlib)修可执行位,没找到 py/python"; exit 1; fi
"$PY" scripts/fix-tarball-mode.py "$TGZ"

echo ""
echo "=== 6. 发布 shine-code-submit@$VERSION(发预打包 tarball,不再 prepublishOnly)==="
if [ -z "$OTP_ARG" ]; then
  echo "npm 随后会提示输入 2FA 的 OTP —— 打开 authenticator app,输 6 位码。"
fi
echo ""
if [ -n "$OTP_ARG" ]; then
  npm publish "$TGZ" --registry="$REGISTRY" --otp="$OTP_ARG"
else
  npm publish "$TGZ" --registry="$REGISTRY"
fi

echo ""
echo "✓ shine-code-submit@$VERSION 已发布到 npm 官方"
echo "  https://www.npmjs.com/package/shine-code-submit"
echo "  国内 npmmirror 约 10 分钟同步,之后 npx shine-code-submit install 即可用"

echo ""
read -r -p "打 git tag v$VERSION 并推到 aliyun?(y/N) " T
if [ "$T" = "y" ]; then
  git tag "v$VERSION"
  git -c http.proxy= push aliyun "v$VERSION"
  echo "✓ tag v$VERSION 已推"
fi
