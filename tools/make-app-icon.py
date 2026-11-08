"""
把 icon-round.png（竖长方形）做成正方形的应用图标。
exe 图标必须是正方形的，否则会被拉变形。

做法：等比缩放到正方形画布中央，底板用圆角白卡（和抠图素材的原始底一致），
四周留一点边距，看起来才像正经软件图标。
"""
import os

from PIL import Image

SRC = r"C:\Users\18169\Documents\工作区 2\vocab-digest\app\public\img"
src = Image.open(os.path.join(SRC, "icon-round.png")).convert("RGBA")

SIZE = 512
CARD = (94, 46)          # 圆角半径占画布比例（相对 SIZE）
BG = (251, 250, 246, 255)  # 奶白纸色，和素材底色一致

canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

# 1. 圆角白卡
radius = int(SIZE * CARD[0] / 100)
card = Image.new("L", (SIZE, SIZE), 0)
from PIL import ImageDraw
d = ImageDraw.Draw(card)
d.rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=radius, fill=255)
canvas.paste(Image.new("RGBA", (SIZE, SIZE), BG), (0, 0), card)

# 2. 等比缩放人像，贴进卡里（左右留 8%，上下按比例居中）
inner = int(SIZE * 0.84)
k = min(inner / src.width, inner / src.height)
im = src.resize((max(1, round(src.width * k)), max(1, round(src.height * k))), Image.LANCZOS)
x = (SIZE - im.width) // 2
y = (SIZE - im.height) // 2
canvas.paste(im, (x, y), im)

out = os.path.join(SRC, "app-icon.png")
canvas.save(out, optimize=True)
print("wrote", out, canvas.size, os.path.getsize(out) // 1024, "KB")
