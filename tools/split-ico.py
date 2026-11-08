"""
把 ico 里的每一帧单独拆开存成 png，逐帧肉眼检查。

背景：Windows 资源管理器按屏幕 DPI 选不同尺寸的帧（常见 32/48/256），
只看其中一帧「能打开」不足以说明整个 ico 是好的。
"""
import os
import struct
import sys

from PIL import Image

path = sys.argv[1] if len(sys.argv) > 1 else r"app\public\img\vocab.ico"
outdir = sys.argv[2] if len(sys.argv) > 2 else r"versions\ico-frames"
os.makedirs(outdir, exist_ok=True)

data = open(path, "rb").read()
reserved, typ, count = struct.unpack_from("<HHH", data, 0)
print(f"reserved={reserved} type={typ} count={count}")

for i in range(count):
    w, h, colors, res, planes, bpp, size, offset = struct.unpack_from("<BBBBHHII", data, 6 + 16 * i)
    w = w or 256
    h = h or 256
    blob = data[offset:offset + size]
    kind = "PNG" if blob[:8] == b"\x89PNG\r\n\x1a\n" else "DIB"
    print(f"[{i}] {w}x{h} bpp={bpp} size={size} off={offset} {kind}")

    # 单独把这一帧包成一个只含单帧的 ico，再让 PIL 读
    single = struct.pack("<HHH", 0, 1, 1)
    single += struct.pack("<BBBBHHII", (0 if w >= 256 else w), (0 if h >= 256 else h), 0, 0, 1, bpp, size, 6 + 16)
    single += blob
    p = os.path.join(outdir, f"frame{i}-{w}.ico")
    open(p, "wb").write(single)
    try:
        im = Image.open(p).convert("RGBA")
        im.save(os.path.join(outdir, f"frame{i}-{w}.png"))
        print("     -> PIL ok")
    except Exception as e:
        print("     -> PIL FAILED", e)
