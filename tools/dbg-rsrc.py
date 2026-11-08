"""
调试：把 PE 里资源目录树打印出来，确认图标资源写得对不对。
（读取方式与 Windows 一致：每个目录 = 16 字节头 + 紧跟其后的条目）
"""
import struct
import sys


def main():
    f = sys.argv[1]
    data = open(f, 'rb').read()
    e = struct.unpack_from('<I', data, 0x3C)[0]
    coff = e + 4
    nsec = struct.unpack_from('<H', data, coff + 2)[0]
    so = struct.unpack_from('<H', data, coff + 16)[0]
    opt = coff + 20
    magic = struct.unpack_from('<H', data, opt)[0]
    is64 = magic == 0x20B
    sect = opt + so

    secs = []
    for i in range(nsec):
        s = sect + 40 * i
        nm = data[s:s + 8].rstrip(b'\0').decode('latin1')
        vs, va, rs, rp = struct.unpack_from('<IIII', data, s + 8)
        secs.append((nm, vs, va, rs, rp))
    print('节:', [x[0] for x in secs])

    def r2o(rva):
        for nm, vs, va, rs, rp in secs:
            if va <= rva < va + max(vs, rs):
                return rp + (rva - va)
        return None

    dd = opt + (112 if is64 else 96)
    rva, size = struct.unpack_from('<II', data, dd + 16)
    base = r2o(rva)
    print(f'资源目录 RVA={rva} size={size} 偏移={base}')
    if not rva:
        return

    # 资源数据条目里的 OffsetToData 是「相对资源节起始」的偏移，
    # 不是 RVA —— 校验时用 base + 偏移是否落在文件内就行
    def walk(off, depth=0, label='root'):
        chars, ts, maj, mi, n_named, n_id = struct.unpack_from('<IIHHHH', data, base + off)
        total = n_named + n_id
        print('  ' * depth + f'{label}@{off}: 条目 {total}（named {n_named} id {n_id}）')
        for i in range(total):
            e_off = base + off + 16 + 16 * i
            name_or_id, ptr = struct.unpack_from('<II', data, e_off)
            is_dir = bool(ptr & 0x80000000)
            sub = ptr & 0x7FFFFFFF
            if is_dir:
                walk(sub, depth + 1, f'id={name_or_id}')
            else:
                drva, dsize, cp, _ = struct.unpack_from('<IIII', data, base + sub)
                end = base + drva + dsize
                ok = 'OK' if end <= len(data) and drva + dsize <= size else '越界'
                print('  ' * (depth + 1) + f'id={name_or_id} -> DATA off={drva} size={dsize} [{ok}]')

    walk(0)


if __name__ == '__main__':
    main()
