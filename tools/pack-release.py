"""
打发布 zip：只放「别人需要的东西」，个人的词表/运行记录/大文件一律不带。

白名单式打包 —— 不是「复制全部再删」，避免以后新增的临时文件又混进去。
"""
import os
import re
import shutil
import zipfile

ROOT = r"C:\Users\18169\Documents\工作区 2\vocab-digest"
OUT = os.path.join(ROOT, "dist", "词汇库-v1.0-windows.zip")

# ── 整目录带上 ──
DIRS = ["bin", "src", "app"]
# ── 根目录下这些文件带上 ──
ROOT_FILES = [
    "package.json",
    "README.md",
    "发布说明.md",
    "config.default.json",
    "cordis.patch.yml",
    "安装.cmd",
    "下载词典.cmd",
    "启动词汇库.cmd",
    "客户端.vbs",
]
# ── tools 只带运行期需要的脚本 ──
TOOLS = ["install.ps1", "install-shortcuts.ps1", "download-dict.ps1"]
# ── data 只带模板（词表、词典、缓存全部不要）──
DATA_FILES = [
    "colloquial.json",
    "lemmatize.exceptions.json",
    "pos.json",
    "stopword.txt",
    "README.md",
    os.path.join("base", "base.txt"),
    os.path.join("known", "known.txt"),
]

# 任何层级都不许出现的 —— 兜底检查用
FORBIDDEN = re.compile(
    r"(^|[\\/])(runs|versions|models|samples|\.trash|node_modules)([\\/]|$)"
    r"|\.part\d*$|\.bak\d*$|\.csv$|ggml-.*\.bin$|_sheet\.png$|_preview.*\.png$"
    r"|^data[\\/]ecdict|^data[\\/]\.ecdict"
    r"|^data[\\/]wordlists[\\/]",   # 用户的词表文件，绝不能带（目录本身不带也行）
    re.IGNORECASE,
)

# 大图源文件不打包（只是设计素材，程序运行用不到）
SKIP_FILES = re.compile(r"sheet\.png$", re.IGNORECASE)


def add(zf, src, arc):
    if not os.path.isfile(src):
        print("  [缺] " + src)
        return 0
    rel = arc.replace("\\", "/")
    if FORBIDDEN.search(rel):
        print("  [拦] " + rel)
        return 0
    if SKIP_FILES.search(rel):
        print("  [跳] " + rel + "（设计素材，运行用不到）")
        return 0
    zf.write(src, rel)
    return 1


def wrong(w):
    """zipfile 里中文默认按 UTF-8 写，这里返回它解码用的字节"""
    return w


if os.path.exists(OUT):
    os.remove(OUT)
os.makedirs(os.path.dirname(OUT), exist_ok=True)

n = 0
with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
    for d in DIRS:
        base = os.path.join(ROOT, d)
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [x for x in dirnames if x != "node_modules"]
            for f in sorted(filenames):
                full = os.path.join(dirpath, f)
                arc = os.path.relpath(full, ROOT)
                n += add(zf, full, arc)
    for f in ROOT_FILES:
        n += add(zf, os.path.join(ROOT, f), f)
    for f in TOOLS:
        n += add(zf, os.path.join(ROOT, "tools", f), os.path.join("tools", f))
    for f in DATA_FILES:
        n += add(zf, os.path.join(ROOT, "data", f), os.path.join("data", f))

print()
print("写入 %d 个文件" % n)
print("zip 大小 %.2f MB" % (os.path.getsize(OUT) / 1024 / 1024))

# ── 打完立刻自检：把清单全列出来，逐条对照禁令 ──
print("\n清单：")
with zipfile.ZipFile(OUT) as zf:
    names = sorted(zf.namelist())
    bad = [x for x in names if FORBIDDEN.search(x)]
    for x in names:
        print("  " + x)
    print("\n条目数 %d，命中禁令 %d 条" % (len(names), len(bad)))
    for x in bad:
        print("  [禁] " + x)
