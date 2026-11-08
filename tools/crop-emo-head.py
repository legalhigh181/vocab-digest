"""
把已经抠好的表情再往里收一刀：只保留「头 + 肩」，
显示尺寸下细节更清楚，文件也更小。
"""
import os
from PIL import Image
import numpy as np

SRC = r"C:\Users\18169\Documents\工作区 2\vocab-digest\app\public\img"
NAMES = ["emo-laugh", "emo-pout", "emo-humph", "emo-shock", "emo-sleepy", "emo-love"]

for name in NAMES:
    p = os.path.join(SRC, name + ".png")
    im = Image.open(p).convert("RGBA")
    w, h = im.size
    alpha = np.asarray(im.getchannel("A"))
    # 找不透明区域的边界
    rows = np.nonzero(alpha.max(axis=1) > 30)[0]
    cols = np.nonzero(alpha.max(axis=0) > 30)[0]
    if len(rows) == 0:
        continue
    y0, y1 = rows[0], rows[-1]
    x0, x1 = cols[0], cols[-1]
    # 只取上半部分（头部），底部留一点肩膀
    cut_h = int((y1 - y0) * 0.80)
    im2 = im.crop((x0, y0, x1 + 1, y0 + cut_h))
    # 缩到 180px 高左右
    if im2.height > 180:
        r = 180 / im2.height
        im2 = im2.resize((max(1, round(im2.width * r)), 180), Image.LANCZOS)
    im2.save(p, optimize=True)
    print(f"  {name:14} {im.size} -> {im2.size}  {os.path.getsize(p)//1024}KB")
