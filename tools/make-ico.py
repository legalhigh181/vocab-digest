"""
生成 Windows 快捷方式用的 .ico —— 用经典 DIB(BMP) 格式，不用 PNG 压缩。

为什么不用 PNG：Vista 之后图标文件允许内嵌 PNG，但有些路径（GDI、部分资源管理器
缓存）读不了内嵌 PNG，会显示成白纸或雪花噪点。DIB 从 Win95 支持到现在，最稳。

验证方式必须是 Windows 原生加载器（System.Drawing.Icon 或 ExtractIconEx），
不能用 PIL —— PIL 的 ico 解析器宽松，坏的 ico 在它那里也可能“能读”。
"""
import os
import struct

from PIL import Image

SRC = r"C:\Users\18169\Documents\工作区 2\vocab-digest\app\public\img"
src = Image.open(os.path.join(SRC, "app-icon.png")).convert("RGBA")


def dib(size):
    """把一个正方形 RGBA 图转成 ICO 里的 DIB 数据块"""
    im = src.copy()
    k = min(size / im.width, size / im.height)
    im = im.resize((max(1, round(im.width * k)), max(1, round(im.height * k))), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(im, ((size - im.width) // 2, (size - im.height) // 2), im)

    px = canvas.load()
    # BITMAPINFOHEADER：高度写两倍（XOR 位图 + AND 掩码）
    header = struct.pack(
        "<IiiHHIIiiII",
        40,                # biSize
        size,              # biWidth
        size * 2,          # biHeight
        1,                 # biPlanes
        32,                # biBitCount
        0,                 # biCompression = BI_RGB
        size * size * 4,   # biSizeImage
        0, 0, 0, 0,
    )
    # XOR 位图：BGRA，自下而上
    body = bytearray()
    for y in range(size - 1, -1, -1):
        for x in range(size):
            r, g, b, a = px[x, y]
            body += bytes((b, g, r, a))
    # AND 掩码：1 位/像素，每行按 4 字节对齐；全 0 = 用 alpha 通道
    row_bytes = ((size + 31) // 32) * 4
    body += bytes(row_bytes * size)
    return header + bytes(body)


SIZES = [16, 24, 32, 48, 64, 128, 256]
blobs = [(s, dib(s)) for s in SIZES]

out = os.path.join(SRC, "vocab.ico")
head = struct.pack("<HHH", 0, 1, len(blobs))
offset = 6 + 16 * len(blobs)
entries = b""
data = b""
for size, blob in blobs:
    w = 0 if size >= 256 else size          # 256 用 0 表示
    entries += struct.pack("<BBBBHHII", w, w, 0, 0, 1, 32, len(blob), offset)
    offset += len(blob)
    data += blob

with open(out, "wb") as f:
    f.write(head + entries + data)
print("ico written", out, os.path.getsize(out), "bytes,", len(blobs), "sizes (DIB)")
