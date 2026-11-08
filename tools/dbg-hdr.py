import struct

d = open(r'build\vocab-client.exe', 'rb').read()
base = 93583872


def hdr(off):
    chars, ts, maj, mi, n_named, n_id = struct.unpack_from('<IIHHHH', d, base + off)
    return f'chars={chars} ts={ts} maj={maj} min={mi} named={n_named} id={n_id}'


for off in (0, 16, 48, 176):
    print(f'@{off}: {hdr(off)}')

print('--- raw @0 ---')
print(' '.join(f'{b:02x}' for b in d[base:base + 48]))
