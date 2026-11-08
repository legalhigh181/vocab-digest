import struct

p = r'build\vocab-client.exe'
d = open(p, 'rb').read()
base = 93583872
rva = 93982720

# 1. 数据条目里 offset=336 的图标数据，前 8 字节应该是 PNG 签名或 BITMAPINFOHEADER
off = base + 336
print('icon1 前 16 字节:', ' '.join(f'{b:02x}' for b in d[off:off + 16]))

# 2. group icon 数据
goff = base + 162284
print('group 前 20 字节:', ' '.join(f'{b:02x}' for b in d[goff:goff + 20]))

# 3. 头部字段总览
e = struct.unpack_from('<I', d, 0x3C)[0]
coff = e + 4
opt = coff + 20
sz_img = struct.unpack_from('<I', d, opt + 56)[0]
print('SizeOfImage', sz_img, '需要 >=', rva + 162388)
chk = struct.unpack_from('<I', d, opt + 64)[0]
print('Checksum', chk)
nsec = struct.unpack_from('<H', d, coff + 2)[0]
print('NumberSections', nsec)

# 4. 检查 .rsrc2 节头
sect = opt + struct.unpack_from('<H', d, coff + 16)[0]
for i in range(nsec):
    s = sect + 40 * i
    nm = d[s:s + 8].rstrip(b'\0').decode('latin1')
    if nm == '.rsrc2':
        print('rsrc2 节头:', ' '.join(f'{b:02x}' for b in d[s:s + 40]))
