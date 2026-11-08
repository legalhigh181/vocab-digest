"""
精修裁切 v3：最终版素材。

原则：只取画面主体，宁可多留一点透明边，也不要混进相邻的标注标签。
所有 keyed 素材都用「纸色 -> 透明」处理，可直接叠在任何底色上。
"""
from PIL import Image

SRC = r"C:\Users\18169\Documents\工作区 2\vocab-digest\app\public\img"
src = Image.open(SRC + r"\logo-sheet.png").convert("RGB")


def paper_of(im):
    px = im.load()
    cands = [px[1, 1], px[im.width - 2, 1], px[1, im.height - 2], px[im.width - 2, im.height - 2]]
    return max(cands, key=lambda c: sum(c))


def keyed(im, tol=28, feather=24):
    r0, g0, b0 = paper_of(im)
    px = im.load()
    out = Image.new("RGBA", im.size)
    po = out.load()
    for y in range(im.height):
        for x in range(im.width):
            r, g, b = px[x, y]
            d = max(abs(r - r0), abs(g - g0), abs(b - b0))
            if d <= tol:
                a = 0
            elif d >= tol + feather:
                a = 255
            else:
                a = int(255 * (d - tol) / feather)
            po[x, y] = (r, g, b, a)
    return out


def trim_alpha(im, pad=3):
    bbox = im.getbbox()
    if not bbox:
        return im
    x0, y0, x1, y1 = bbox
    return im.crop((max(0, x0 - pad), max(0, y0 - pad), min(im.width, x1 + pad), min(im.height, y1 + pad)))


def cut(box, name, mode="keyed", trim=True, maxw=None, maxh=None):
    im = src.crop(box)
    if mode == "keyed":
        im = keyed(im)
        if trim:
            im = trim_alpha(im)
    if maxw or maxh:
        ratio = 1.0
        if maxw and im.width > maxw:
            ratio = min(ratio, maxw / im.width)
        if maxh and im.height > maxh:
            ratio = min(ratio, maxh / im.height)
        if ratio < 1.0:
            im = im.resize((max(1, round(im.width * ratio)), max(1, round(im.height * ratio))), Image.LANCZOS)
    im.save(f"{SRC}\\{name}.png", optimize=True)
    print(f"  {name:16} {im.size}")


# 主 Logo：下边界收 575（避开最下面那条「辅助元素」标签），左 40 右 790
cut((40, 68, 790, 578), "logo-main", maxw=620)

# 横版 Logo：左边界 870（避开「横版Logo」标签的右端），右 1490
cut((868, 55, 1490, 225), "logo-wide", maxw=640)

# Q 版头像（圆形贴纸）
cut((1008, 335, 1255, 570), "icon-round", maxw=200)

# 方角头像（天蓝底）
cut((1058, 358, 1220, 558), "icon-square", maxw=180)

# 反白版（深蓝底，整块保留不透明）
cut((1252, 358, 1512, 562), "logo-inverse", mode="solid", maxw=260)

# 辅助元素
cut((50, 648, 292, 822), "el-whale", maxw=225)
cut((508, 735, 682, 876), "el-bow", maxw=165)
cut((305, 622, 495, 695), "el-wave", maxw=185)
cut((315, 838, 450, 950), "el-tail", maxw=135)
cut((630, 888, 772, 992), "el-apron", maxw=138)
