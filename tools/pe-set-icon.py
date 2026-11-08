"""
给 Windows PE 文件（.exe）换图标 —— 纯 Python 重写 .rsrc 资源节，不依赖 rcedit 等外部工具。

步骤：
  1. 生成一个带图标的 ICO 数据块（RT_GROUP_ICON + 若干 RT_ICON）
  2. 解析 PE：DOS 头 -> NT 头 -> 节表 -> 找最后一个节
  3. 在文件末尾追加一个新节 .rsrc2（放资源树），把 DataDirectory[2] 指向它
  4. 在节表里登记这个新节，更新 SizeOfImage

只做「加一个资源节」这一件事，不改代码、不重定位，所以对 Node 生成的 exe 是安全的。
"""

import struct


def align(v, a):
    return (v + a - 1) // a * a


# ── 1. 图标数据 ──────────────────────────────────────────────

def load_ico(path):
    """读 .ico，返回 [(w, h, colorcount, planes, bpp, data), ...]"""
    with open(path, "rb") as f:
        blob = f.read()
    reserved, typ, count = struct.unpack_from("<HHH", blob, 0)
    assert reserved == 0 and typ == 1, "不是 ICO"
    entries = []
    for i in range(count):
        (w, h, cc, res, planes, bpp, size, off) = struct.unpack_from("<BBBBHHII", blob, 6 + 16 * i)
        entries.append((w, h, cc, planes, bpp, blob[off:off + size]))
    return entries


def build_icon_group(entries, ids):
    """RT_GROUP_ICON 的内容：ICONDIR + ICONDIRENTRY[]"""
    out = struct.pack("<HHH", 0, 1, len(entries))
    for (w, h, cc, planes, bpp, data), iid in zip(entries, ids):
        out += struct.pack("<BBBBHHIH", w, h, cc, 0, planes, bpp, len(data), iid)
    return out


# ── 2. 资源目录 ──────────────────────────────────────────────

RT_ICON = 3
RT_GROUP_ICON = 14


def build_resource_section(tree):
    """
    tree: {type_id: {name_id: [data bytes, ...]}}
    返回节内容字节。目录里的偏移都是「相对资源节起始」的偏移。
    布局：root(16) | type 表(16*n_type) | name 表(16*n_names) | data 条目(16*n_data) | 数据区
    """
    type_ids = sorted(tree.keys())
    n_type = len(type_ids)
    names_of = {t: sorted(tree[t].keys()) for t in type_ids}
    entries = []
    for t in type_ids:
        for n in names_of[t]:
            for blob in tree[t][n]:
                entries.append((t, n, blob))
    n_data = len(entries)

    # 布局（Windows 的标准写法：每个目录 = 16 字节头 + 紧跟其后的条目）
    #   0            : 根目录头(16) + 根条目(16*n_type)
    #   接着每个类型: 子目录头(16) + 条目(16*该类型名字数)
    #   然后        : 数据条目(16*n_data)
    #   最后        : 数据区
    root_entries_off = 16
    cursor = root_entries_off + 16 * n_type

    type_dir_off = {}
    for t in type_ids:
        type_dir_off[t] = cursor
        cursor += 16 + 16 * len(names_of[t])

    data_entry_off = cursor
    data_start = data_entry_off + 16 * n_data

    body = bytearray(data_start)

    # 根目录
    struct.pack_into("<IIHHHH", body, 0, 0, 0, 4, 0, 0, n_type)
    for i, t in enumerate(type_ids):
        struct.pack_into("<II", body, root_entries_off + 16 * i, t, 0x80000000 | type_dir_off[t])

    # 每个类型的子目录：头 + 自己的条目
    data_idx = 0
    for t in type_ids:
        d_off = type_dir_off[t]
        names = names_of[t]
        struct.pack_into("<IIHHHH", body, d_off, 0, 0, 4, 0, 0, len(names))
        for j, n in enumerate(names):
            struct.pack_into("<II", body, d_off + 16 + 16 * j, n, data_entry_off + 16 * data_idx)
            data_idx += len(tree[t][n])

    # 数据区
    pos = data_start
    for i, (t, n, blob) in enumerate(entries):
        padded_len = align(len(blob), 4)
        struct.pack_into("<IIII", body, data_entry_off + 16 * i, pos, len(blob), 0, 0)
        body += blob
        body += b"\0" * (padded_len - len(blob))
        pos += padded_len

    return bytes(body)


def set_icon(exe_path, ico_path, group_id=1, base_icon_id=1):
    entries = load_ico(ico_path)
    ids = [base_icon_id + i for i in range(len(entries))]
    group_blob = build_icon_group(entries, ids)

    tree = {
        RT_GROUP_ICON: {group_id: [group_blob]},
        RT_ICON: {ids[i]: [entries[i][5]] for i in range(len(entries))},
    }
    section = build_resource_section(tree)

    with open(exe_path, "rb") as f:
        data = bytearray(f.read())

    # ── PE 头 ──
    assert data[0:2] == b"MZ", "不是 PE 文件"
    e_lfanew = struct.unpack_from("<I", data, 0x3C)[0]
    assert data[e_lfanew:e_lfanew + 4] == b"PE\0\0", "没有 PE 签名"
    coff = e_lfanew + 4
    num_sec, = struct.unpack_from("<H", data, coff + 2)
    size_opt_header, = struct.unpack_from("<H", data, coff + 16)
    opt = coff + 20
    magic, = struct.unpack_from("<H", data, opt)
    is_pe32_plus = magic == 0x20B
    dd_off = opt + (112 if is_pe32_plus else 96)
    sec_table = opt + size_opt_header

    # 找节表末尾，取最大 VA / 文件偏移
    last_va_end = 0
    last_raw_end = 0
    file_align = struct.unpack_from("<I", data, opt + 36)[0]
    sect_align = struct.unpack_from("<I", data, opt + 32)[0]
    image_base = struct.unpack_from("<Q" if is_pe32_plus else "<I", data, opt + (24 if not is_pe32_plus else 24))[0]
    for i in range(num_sec):
        s = sec_table + 40 * i
        vsize, vaddr, rawsize, rawptr = struct.unpack_from("<IIII", data, s + 8)
        last_va_end = max(last_va_end, vaddr + max(vsize, rawsize))
        last_raw_end = max(last_raw_end, rawptr + rawsize)

    new_va = align(last_va_end, sect_align)
    new_raw_ptr = align(max(last_raw_end, len(data)), file_align)
    raw = bytes(section) + b"\0" * (align(len(section), file_align) - len(section))

    # 追加节头
    if sec_table + 40 * num_sec > new_raw_ptr:
        raise RuntimeError("节表空间不够，无法追加新节")

    hdr = bytearray(40)
    hdr[0:8] = b".rsrc2\0\0"
    struct.pack_into("<I", hdr, 8, len(section))       # VirtualSize
    struct.pack_into("<I", hdr, 12, new_va)            # VirtualAddress
    struct.pack_into("<I", hdr, 16, len(raw))          # SizeOfRawData
    struct.pack_into("<I", hdr, 20, new_raw_ptr)       # PointerToRawData
    struct.pack_into("<I", hdr, 36, 0x40000040)        # 初始化数据 | 可读
    data[sec_table + 40 * num_sec: sec_table + 40 * (num_sec + 1)] = hdr

    # 节数 +1
    struct.pack_into("<H", data, coff + 2, num_sec + 1)

    # SizeOfImage 增长
    size_image, = struct.unpack_from("<I", data, opt + 56)
    new_size_image = align(new_va + len(section), sect_align)
    struct.pack_into("<I", data, opt + 56, max(size_image, new_size_image))

    # DataDirectory[2] = 资源
    struct.pack_into("<II", data, dd_off + 2 * 8, new_va, len(section))

    # 校验和置 0（PE 校验和只对驱动/系统文件强制）
    struct.pack_into("<I", data, opt + 64, 0)

    # 写入节数据
    if len(data) < new_raw_ptr:
        data += b"\0" * (new_raw_ptr - len(data))
    data[new_raw_ptr:new_raw_ptr + len(raw)] = raw

    with open(exe_path, "wb") as f:
        f.write(data)
    return new_va, len(section)


if __name__ == "__main__":
    import sys
    set_icon(sys.argv[1], sys.argv[2])
    print("icon set")
