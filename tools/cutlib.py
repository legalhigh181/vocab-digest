"""
抠图库 v3：外部泛洪判背景（保留完整轮廓与内部颜色）。

核心思路：
  1. 估出纸色
  2. 在原图四周补一圈「纸色」边（打底），让所有外部背景连成一片
  3. 从补边的角落用 floodfill 把「纸色区域」涂成标记色（容差 tol）
  4. 标记色 = 背景 → 透明；其余全部保留（围裙的白、蕾丝的白、高光都留着）
  5. 边缘轻微羽化

要点：只吃「跟外面连通的纸」，不吃「画面内部被线围住的白」。
"""
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

MAGIC = (255, 0, 255)  # 标记色：这张图里不可能出现的洋红


def _paper_color(rgb):
    """四角取样估纸色"""
    h, w, _ = rgb.shape
    pad = max(4, min(h, w) // 25)
    corners = np.concatenate([
        rgb[0:pad, 0:pad].reshape(-1, 3),
        rgb[0:pad, w - pad:w].reshape(-1, 3),
        rgb[h - pad:h, 0:pad].reshape(-1, 3),
        rgb[h - pad:h, w - pad:w].reshape(-1, 3),
    ])
    # 用较亮的四分位，纸通常比主体亮
    lum = corners.mean(axis=1)
    pick = corners[lum >= np.percentile(lum, 65)]
    return np.median(pick, axis=0)


def cutout(im, tol=32, pad=6, feather=0.8, seal=2):
    """返回抠好背景的 RGBA。tol 越大吃掉的纸越多（但可能咬到浅色笔触）。

    seal：先给「笔触」做一次闭运算（膨胀再腐蚀），把 1~2 像素宽的缝隙封住。
    不加这一步，泛洪会从线稿的细微缺口漏进脸部，把嘴巴一起吃掉 ——
    表现就是「眼睛在，嘴没了」。
    """
    rgb_im = im.convert("RGB")
    rgb = np.asarray(rgb_im).astype(np.float32)
    paper = _paper_color(rgb)

    # 1) 笔触掩膜：和纸色差得够远的像素（L 模式里要画成「黑」才是障碍，
    #    白色代表「可填充的纸」，所以这里取反存成 255 - ink）
    dist = np.max(np.abs(rgb - paper[None, None, :]), axis=2)
    ink = (dist > tol).astype(np.uint8) * 255

    if seal:
        m = Image.fromarray(ink, mode="L")
        m = m.filter(ImageFilter.MaxFilter(seal * 2 + 1)).filter(ImageFilter.MinFilter(seal * 2 + 1))
        ink = np.asarray(m)

    barrier = 255 - ink  # 笔触=0（黑），纸=255（白）

    # 2) 补一圈纸色（白）让外部连通
    w, h = rgb_im.size
    canvas = Image.new("L", (w + pad * 2, h + pad * 2), 255)
    canvas.paste(Image.fromarray(barrier, mode="L"), (pad, pad))

    # 3) 从角落泛洪，把「连通的纸」涂成洋红
    work = canvas.convert("RGB")
    ImageDraw.floodfill(work, (0, 0), MAGIC, thresh=10)
    marked = np.all(np.asarray(work) == np.array(MAGIC, dtype=np.uint8), axis=2)

    body = marked[pad:pad + h, pad:pad + w]
    alpha = np.where(body, 0, 255).astype(np.uint8)

    a = Image.fromarray(alpha, mode="L")
    if feather:
        a = a.filter(ImageFilter.GaussianBlur(feather))

    out = np.dstack([np.asarray(rgb_im), np.asarray(a).astype(np.uint8)])
    return Image.fromarray(out, mode="RGBA")


def _components(mask):
    """4 连通域标注，返回 [(area, ys, xs)]，按面积降序"""
    h, w = mask.shape
    seen = np.zeros((h, w), dtype=bool)
    comps = []
    ys, xs = np.nonzero(mask)
    for sy, sx in zip(ys, xs):
        if seen[sy, sx]:
            continue
        stack = [(sy, sx)]
        seen[sy, sx] = True
        cy, cx = [], []
        while stack:
            y, x = stack.pop()
            cy.append(y)
            cx.append(x)
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                ny, nx = y + dy, x + dx
                if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    stack.append((ny, nx))
        comps.append((len(cy), np.array(cy), np.array(cx)))
    comps.sort(key=lambda c: -c[0])
    return comps


def drop_islands(im, ratio=0.03, keep_max=4):
    """只保留主要连通块，去掉邻格残片、标签、飞点。

    ratio    : 面积小于「最大块 × ratio」的块丢弃
    keep_max : 最多保留几个块（主体 + 自带的小装饰，如星星/爱心）
    """
    alpha = np.asarray(im.getchannel("A"))
    solid = alpha > 60
    comps = _components(solid)
    if not comps:
        return im
    biggest = comps[0][0]
    keep = np.zeros_like(solid)
    n = 0
    for area, ys, xs in comps:
        if area < biggest * ratio:
            continue
        keep[ys, xs] = True
        n += 1
        if n >= keep_max:
            break
    # 羽化带跟着保留（否则边缘会硬切）
    band = Image.fromarray((keep.astype(np.uint8) * 255), mode="L").filter(ImageFilter.MaxFilter(7))
    band = np.asarray(band) > 0
    new_alpha = np.where(keep, alpha, np.where(band, (alpha * 0.55).astype(np.uint8), 0))
    out = np.dstack([np.asarray(im.convert("RGB")), new_alpha.astype(np.uint8)])
    return Image.fromarray(out, mode="RGBA")


def keep_subject(im, grow=46, min_rel=0.002):
    """只保留「主体 + 主体附近的装饰」。

    主体 = 面积最大的连通块（角色本体）
    装饰 = 质心落在「主体外扩 grow 像素的框」内的小块（感叹号、星星、爱心、zZz）
    其余（邻格头发、画面标签、边框残条）一律丢掉。
    """
    alpha = np.asarray(im.getchannel("A"))
    solid = alpha > 60
    comps = _components(solid)
    if len(comps) <= 1:
        return im

    area0, ys0, xs0 = comps[0]
    y0, y1 = ys0.min(), ys0.max()
    x0, x1 = xs0.min(), xs0.max()

    keep = np.zeros_like(solid)
    keep[ys0, xs0] = True
    for area, ys, xs in comps[1:]:
        if area < area0 * min_rel:
            continue
        cy = ys.mean()
        cx = xs.mean()
        if (y0 - grow) <= cy <= (y1 + grow) and (x0 - grow) <= cx <= (x1 + grow):
            keep[ys, xs] = True

    band = Image.fromarray((keep.astype(np.uint8) * 255), mode="L").filter(ImageFilter.MaxFilter(7))
    band = np.asarray(band) > 0
    new_alpha = np.where(keep, alpha, np.where(band, (alpha * 0.6).astype(np.uint8), 0))
    out = np.dstack([np.asarray(im.convert("RGB")), new_alpha.astype(np.uint8)])
    return Image.fromarray(out, mode="RGBA")


def trim(im, pad=2, thr=10):
    """裁掉四周透明空白"""
    alpha = np.asarray(im.getchannel("A"))
    rows = np.nonzero(alpha.max(axis=1) > thr)[0]
    cols = np.nonzero(alpha.max(axis=0) > thr)[0]
    if len(rows) == 0 or len(cols) == 0:
        return im
    y0, y1 = rows[0], rows[-1]
    x0, x1 = cols[0], cols[-1]
    return im.crop((
        max(0, x0 - pad), max(0, y0 - pad),
        min(im.width, x1 + pad + 1), min(im.height, y1 + pad + 1),
    ))


def fit(im, maxw=None, maxh=None):
    ratio = 1.0
    if maxw and im.width > maxw:
        ratio = min(ratio, maxw / im.width)
    if maxh and im.height > maxh:
        ratio = min(ratio, maxh / im.height)
    if ratio < 1.0:
        im = im.resize((max(1, round(im.width * ratio)), max(1, round(im.height * ratio))), Image.LANCZOS)
    return im
