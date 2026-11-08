"""
从 exe 的 .rsrc2 里把 RT_GROUP_ICON 取出来，重建成 .ico，用来验证资源写得对不对。
"""
import struct
import sys

from PIL import Image

f = sys.argv[1]
data = open(f, 'rb').read()
e = struct.unpack_from('<I', data, 0x3C)[0]
coff = e + 4
nsec = struct.unpack_from('<H', data, coff + 2)[0]
so = struct.unpack_from('<H', data, coff + 16)[0]
opt = coff + 20
sect = opt + so

secs = []
for i in range(nsec):
    s = sect + 40 * i
    nm = data[s:s + 8].rstrip(b'\0').decode('latin1')
    vs, va, rs, rp = struct.unpack_from('<IIII', data, s + 8)
    secs.append((nm, vs, va, rs, rp))


def r2o(rva):
    for nm, vs, va, rs, rp in secs:
        if va <= rva < va + max(vs, rs):
            return rp + (rva - va)
    return None


dd = opt + 112
rsrc_rva, rsrc_size = struct.unpack_from('<II', data, dd + 16)
base = r2o(rsrc_rva)
print('rsrc at', base, 'size', rsrc_size)


def entries(off):
    chars, ts, maj, mi, n_named, n_id = struct.unpack_from('<IIHHHH', data, base + off)
    out = []
    for i in range(n_named + n_id):
        e_off = base + off + 16 + 16 * (i + 1)   # 16 字节头 + 条目
        name_or_id, ptr = struct.unpack_from('<II', data, e_off)
        out.append((name_or_id, ptr))
    return out, base + off


def data_entry(off):
    rva, size, cp, _ = struct.unpack_from('<IIII', data, base + off)
    o = r2o(rva)
    return data[o:o + size]


root, _ = entries(0)
rid = {n: p for n, p in root}
print('资源类型:', [hex(n) for n, _ in root])

# 图标组 = 类型 14
t14 = [p & 0x7FFFFFFF for n, p in root if n == 14]
assert t14, '没有 RT_GROUP_ICON'
sub, _ = entries(t14[0])
grp = data_entry(sub[0][1] & 0x7FFFFFFF)
reserved, typ, count = struct.unpack_from('<HHH', grp, 0)
print('组内图标数', count)

# 16 类型下每个 id 对应的数据
t16 = [p & 0x7FFFFFFF for n, p in root if n == 3][0]
icons = {}
for nid, ptr in entries(t16)[0]:
    icons[nid] = data_entry(ptr & 0x7FFFFFFF)

out = bytearray(grp)  # 直接用组数据当 ICO 头 + 条目
off = 6 + 16 * count
new = bytearray()
for i in range(count):
    ent = 6 + 16 * i
    w, h, cc, res, planes, bpp, size, iid = struct.unpack_from('<BBBBHHIH', grp, ent)
    blob = icons[iid]
    struct.pack_into('<BBBBHHII', out, ent, w, h, cc, res, planes, bpp, len(blob), off)
    off += len(blob)
    new += blob
ico = bytes(out[:6 + 16 * count]) + bytes(new)
open(r'C:\Users\18169\Documents\工作区 2\vocab-digest\versions\_from-exe.ico', 'wb').write(ico)

im = Image.open(r'C:\Users\18169\Documents\工作区 2\vocab-digest\versions\_from-exe.ico')
print('ico', im.size, sorted(im.info.get('sizes', [])))
im.size = (128, 128)
im.load()
im.convert('RGBA').save(r'C:\Users\18169\Documents\工作区 2\vocab-digest\versions\_from-exe.png')
print('ok')
