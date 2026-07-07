"""把 npm tarball 里 dist/install.cjs 的权限改成 0o755(可执行)。

Windows 上 npm pack 不保留 +x 位(POSIX mode 在 Windows 是假的,fs.stat 拿不到执行位),
导致发布出去的 install.cjs 不可执行 → Linux 上 `npx shine-code-submit install` 经
.bin 符号链接 + shebang 执行时报 "Permission denied"。打包后用 tarfile 直接改 tar 条目
的 mode,再 publish 这个 tarball(`npm publish <tgz>` 不再重打包)。

用法: py scripts/fix-tarball-mode.py shine-code-submit-0.2.4.tgz
"""
import sys
import tarfile
import shutil

if len(sys.argv) != 2:
    sys.exit("usage: fix-tarball-mode.py <tarball.tgz>")

tgz = sys.argv[1]
TARGET = "package/dist/install.cjs"
MODE = 0o755

tmp = tgz + ".fixed"
seen = False
with tarfile.open(tgz, "r:gz") as inp, tarfile.open(tmp, "w:gz") as out:
    for m in inp:
        if m.name == TARGET:
            m.mode = MODE
            seen = True
        out.addfile(m, inp.extractfile(m) if m.isreg() else None)

if not seen:
    __import__("os").remove(tmp)
    sys.exit(f"[ERROR] tarball 里没找到 {TARGET}")

shutil.move(tmp, tgz)
# 用 ASCII 输出,避免 Windows GBK 控制台对 ✓ 等字符报 UnicodeEncodeError(会让脚本非零退出)
print(f"[OK] {TARGET} -> 0{MODE:o} in {tgz}")
