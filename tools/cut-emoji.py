"""
抽表情包 v4：先在整块表情区里找出「6 个主体」，再按各自包围盒裁切 + 抠背景。

这样不会再把邻格的头发带进来 ——
因为每个表情都按「它自己那一大块连通区域」定框，
装饰（!!!、♥、zZz、星星）只有在主体附近时才一起带走。
"""
import os
import sys

import numpy as np
from PIL import Image, ImageFilter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cutlib import cutout, trim, fit, _components

SRC = r"C:\Users\18169\Documents\工作区 2\vocab-digest\app\public\img"
sheet = Image.open(os.path.join(SRC, "style-sheet.png")).convert("RGB")

REGION = (676, 62, 1312, 498)
region = sheet.crop(REGION)
arr = np.asarray(region).astype(int)
paper = np.array([251, 249, 247])
content = np.abs(arr - paper).max(axis=2) > 45

comps = _components(content)
if not comps:
    raise SystemExit("没找到内容")

biggest = comps[0][0]
# 主体：显著大的块（每个表情本体）
subjects = [c for c in comps if c[0] >= biggest * 0.25]
print(f"连通块 {len(comps)} 个，其中主体级 {len(subjects)} 个")

# 按「行带（上/下）+ 列顺序」排序，得到 6 个表情的顺序
def cen(c):
    return c[1].mean(), c[2].mean()

rows = sorted(subjects, key=lambda c: cen(c)[0])
# 先按 y 分成两行（y 中位数差 > 区域高 25% 就分行）
if len(rows) >= 2:
    ys = [cen(c)[0] for c in rows]
    mid = (min(ys) + max(ys)) / 2
    line1 = [c for c in rows if cen(c)[0] < mid]
    line2 = [c for c in rows if cen(c)[0] >= mid]
else:
    line1, line2 = rows, []

ordered = sorted(line1, key=lambda c: cen(c)[1]) + sorted(line2, key=lambda c: cen(c)[1])
print("主体顺序（面积, 质心x/y）:", [(c[0], round(cen(c)[1]), round(cen(c)[0])) for c in ordered])

# 先算出「每一格的地盘」：同一行内，两个主体的中线就是这一格左右边界
# 否则两格之间的爱心、头发会被相邻两格同时收走，出现重复或残留
bands = {}
for line in (line1, line2):
    line_ordered = sorted(line, key=lambda c: cen(c)[1])
    centers = [cen(c)[1] for c in line_ordered]
    for i, c in enumerate(line_ordered):
        lo = 0 if i == 0 else (centers[i - 1] + centers[i]) / 2
        hi = region.width if i == len(centers) - 1 else (centers[i] + centers[i + 1]) / 2
        bands[id(c)] = (lo, hi)

# 上下也要划界：以第一行最下和第二行最上之间的中线作为分界，
# 否则上排会把下排的 zZz 一起收走
row_bands = {}
if line1 and line2:
    split_y = (max(cen(c)[0] for c in line1) + min(cen(c)[0] for c in line2)) / 2
    for c in line1:
        row_bands[id(c)] = (0, split_y)
    for c in line2:
        row_bands[id(c)] = (split_y, region.height)
else:
    for c in line1:
        row_bands[id(c)] = (0, region.height)

NAMES = ["emo-laugh", "emo-pout", "emo-humph", "emo-shock", "emo-sleepy", "emo-love"]

for subj, name in zip(ordered, NAMES):
    area0, ys0, xs0 = subj
    x0, x1 = xs0.min(), xs0.max()
    y0, y1 = ys0.min(), ys0.max()
    band_lo, band_hi = bands.get(id(subj), (0, region.width))

    # 这一格的地盘：左右按中线切，上下按行的中线切
    cell_lo = band_lo - 2
    cell_hi = band_hi + 2
    cell_top, cell_bot = row_bands.get(id(subj), (0, region.height))

    # 关键：把「质心落在这格地盘里」的所有连通块都收下 —— 不按面积筛。
    # 嘴巴、眉毛这类细线是独立的小连通块，按面积筛会把它们丢掉，
    # 表现出来就是「眼睛还在，嘴没了」。
    keep_comps = []
    for c in comps:
        cy, cx = cen(c)
        # 区域左边缘那一条「隔壁面板的竖边」不能被算进来
        if cx < 8:
            continue
        if cell_lo <= cx <= cell_hi and cell_top <= cy <= cell_bot:
            keep_comps.append(c)
    if subj not in keep_comps:
        keep_comps.append(subj)

    ax0 = min(c[2].min() for c in keep_comps)
    ax1 = max(c[2].max() for c in keep_comps)
    ay0 = min(c[1].min() for c in keep_comps)
    ay1 = max(c[1].max() for c in keep_comps)

    pad = 4
    box = (
        max(0, ax0 - pad), max(0, ay0 - pad),
        min(region.width, ax1 + pad + 1), min(region.height, ay1 + pad + 1),
    )
    crop = region.crop(box)
    out = cutout(crop, tol=34, feather=0.7)

    # 精确遮罩：只保留「归这个表情的连通块」，而不是再按距离猜一遍
    # （按距离猜会把紧贴着的邻格爱心/头发一起留下）
    m = np.zeros((region.height, region.width), dtype=bool)
    for c in keep_comps:
        m[c[1], c[2]] = True
    m = m[box[1]:box[3], box[0]:box[2]]
    mask = Image.fromarray((m * 255).astype(np.uint8), mode="L")
    mask = mask.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.GaussianBlur(1.2))
    alpha = out.split()[3]
    alpha = Image.composite(alpha, Image.new("L", alpha.size, 0), mask)
    out.putalpha(alpha)

    out = trim(out, pad=2)
    out = fit(out, maxh=230)
    out.save(os.path.join(SRC, name + ".png"), optimize=True)
    print(f"  {name:12} {out.size}  {os.path.getsize(os.path.join(SRC, name + '.png')) // 1024}KB  box={box}")
