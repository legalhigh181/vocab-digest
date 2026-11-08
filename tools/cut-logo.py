"""
重抠 Logo / 装饰素材：用泛洪去背 + 宽松包围盒，保证文字与笔触完整。

坐标按设定图（1536x1024）量：
  主 Logo      x 30..792,  y 62..600    （含 DeepSeek 字样、Virtual Maid、底部蝴蝶结）
  横版 Logo    x 800..1505, y 50..240   （鲸鱼 + DeepSeek + Virtual Maid + 小蝴蝶结）
  Q 版头像     x 1005..1262,y 330..578
  方角头像     x 1050..1228,y 352..566
  反白版       x 1246..1518,y 352..570
  鲸鱼         x 42..300,   y 640..830
  蝴蝶结       x 500..690,  y 728..884
  浪花         x 296..505,  y 615..700
  尾巴         x 305..462,  y 828..958
  围裙         x 620..782,  y 880..1000
"""
import os
import sys

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cutlib import cutout, keep_subject, trim, fit

SRC = r"C:\Users\18169\Documents\工作区 2\vocab-digest\app\public\img"
sheet = Image.open(os.path.join(SRC, "logo-sheet.png")).convert("RGB")


def harden(im, thr=45):
    """把「几乎透明」的雾状像素直接清成 0。

    不清的话，纸色会在画内部围出一些小块，因为不与外部连通而保留下来，
    整张图看起来就像带了个淡淡的方底。
    """
    a = im.split()[3].point(lambda v: 0 if v < thr else v)
    im.putalpha(a)
    return im

JOBS = [
    # 名字,          包围盒,                         最大边,  tol,  是否只留主体
    # 带文字的（主 Logo / 横版 Logo）不能做「只留主体」：
    # 字母是分离的小块，会被当成杂点删掉 —— 这正是上一版把 "DeepSeek" 切丢的原因
    ("logo-main",    (32, 72, 792, 586),             560,   36,  False),
    ("logo-wide",    (812, 78, 1502, 244),           700,   36,  False),
    ("icon-round",   (1005, 332, 1262, 576),         210,   34,  True),
    ("icon-square",  (1052, 354, 1226, 564),         200,   34,  True),
    ("logo-inverse", (1246, 352, 1518, 570),         260,   34,  False),
    ("el-whale",     (42, 642, 298, 828),            230,   34,  True),
    ("el-bow",       (504, 732, 688, 880),           180,   34,  True),
    ("el-wave",      (298, 616, 503, 698),           195,   34,  True),
    ("el-tail",      (308, 830, 458, 954),           145,   34,  True),
    ("el-apron",     (622, 882, 780, 1000),          145,   34,  True),
]

for name, box, maxw, tol, only_subject in JOBS:
    crop = sheet.crop(box)
    if name == "logo-inverse":
        # 反白版是深蓝底整块，不能去背 —— 原样保留
        out = crop
    else:
        out = cutout(crop, tol=tol, feather=0.6)
        out = harden(out)
        if only_subject:
            # 装饰类素材：去掉混进来的标注标签与飞点
            out = keep_subject(out, grow=14, min_rel=0.004)
        out = trim(out, pad=2)
    out = fit(out, maxw=maxw)
    out.save(os.path.join(SRC, name + ".png"), optimize=True)
    print(f"  {name:13} {out.size}  {os.path.getsize(os.path.join(SRC, name + '.png')) // 1024}KB")
