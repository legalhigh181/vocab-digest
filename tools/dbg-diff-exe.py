"""
逐字节对比「干净的 node.exe」和「注入后的 exe」，找出头部被改坏了哪几个字节。
"""
import struct
import sys

a_path = r"build\test-clean.exe"
b_path = r"build\test-sea.exe"

a = open(a_path, "rb").read()
b = open(b_path, "rb").read()
print(f"clean {len(a)} bytes")
print(f"inject {len(b)} bytes  (+{len(b) - len(a)})")


def parse(d):
    e = struct.unpack_from("<I", d, 0x3C)[0]
    coff = e + 4
    opt = coff + 20
    magic = struct.unpack_from("<H", d, opt)[0]
    nsec = struct.unpack_from("<H", d, coff + 2)[0]
    size_opt = struct.unpack_from("<H", d, coff + 16)[0]
    sec_tab = opt + size_opt
    size_img = struct.unpack_from("<I", d, opt + 56)[0]
    size_hdr = struct.unpack_from("<I", d, opt + 60)[0]
    checksum = struct.unpack_from("<I", d, opt + 64)[0]
    subsystem = struct.unpack_from("<H", d, opt + 68)[0]
    dllchar = struct.unpack_from("<H", d, opt + 70)[0]
    secs = []
    for i in range(nsec):
        s = sec_tab + 40 * i
        name = d[s:s + 8].rstrip(b"\0").decode("latin1")
        vsize, vaddr, rawsize, rawptr = struct.unpack_from("<IIII", d, s + 8)
        ch = struct.unpack_from("<I", d, s + 36)[0]
        secs.append((name, vsize, vaddr, rawsize, rawptr, ch))
    return dict(e=e, coff=coff, opt=opt, magic=magic, nsec=nsec, size_opt=size_opt,
                sec_tab=sec_tab, size_img=size_img, size_hdr=size_hdr, checksum=checksum,
                subsystem=subsystem, dllchar=dllchar, secs=secs)


pa = parse(a)
pb = parse(b)
print()
print("=== 头部字段对比 ===")
for k in ["magic", "nsec", "size_img", "size_hdr", "checksum", "subsystem", "dllchar"]:
    flag = "" if pa[k] == pb[k] else "   <-- 变了"
    print(f"  {k:10} clean={pa[k]:>12}  inject={pb[k]:>12}{flag}")

print()
print("=== 节表对比 ===")
for i in range(max(len(pa["secs"]), len(pb["secs"]))):
    sa = pa["secs"][i] if i < len(pa["secs"]) else None
    sb = pb["secs"][i] if i < len(pb["secs"]) else None
    if sa and sb and sa == sb:
        print(f"  [{i}] {sa[0]:<10} 相同")
    else:
        print(f"  [{i}] clean={sa}")
        print(f"      inject={sb}")

print()
print("=== 前 4096 字节里所有不同的位置 ===")
diffs = [(i, a[i], b[i]) for i in range(min(len(a), 4096)) if a[i] != b[i]]
for i, x, y in diffs:
    print(f"  offset {i:#06x} (0x{i:04X}): {x:02x} -> {y:02x}")
print("共", len(diffs), "处不同（前 4096 字节内）")

print()
print("=== 整个文件里不同的字节总数（只看公共长度） ===")
n = min(len(a), len(b))
total = sum(1 for i in range(n) if a[i] != b[i])
print(" ", total, "字节不同")
