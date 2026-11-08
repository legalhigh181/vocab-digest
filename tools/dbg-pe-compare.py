"""
对比 node.exe 和改过的 exe 的关键 PE 头字段，找出被破坏的地方。

Node 报「only supported on Windows 10 or higher」是因为它检查了
IMAGE_OPTIONAL_HEADER 里的 MajorOperatingSystemVersion / MinorOperatingSystemVersion。
如果这两个字段被踩坏（比如写成了 0），Node 就会以为系统太老。
"""
import struct
import sys


def dump(path):
    d = open(path, 'rb').read()
    e = struct.unpack_from('<I', d, 0x3C)[0]
    coff = e + 4
    opt = coff + 20
    print(f'--- {path} ({len(d)} bytes) ---')
    print('  Machine              ', hex(struct.unpack_from('<H', d, coff)[0]))
    print('  NumberOfSections     ', struct.unpack_from('<H', d, coff + 2)[0])
    print('  SizeOfOptionalHeader ', struct.unpack_from('<H', d, coff + 16)[0])
    print('  Characteristics      ', hex(struct.unpack_from('<H', d, coff + 18)[0]))
    print('  Magic                ', hex(struct.unpack_from('<H', d, opt)[0]))
    maj, minr = struct.unpack_from('<HH', d, opt + 2)
    print('  LinkerVersion        ', f'{maj}.{minr}')
    szcode, szinit, szuninit = struct.unpack_from('<III', d, opt + 4)
    print('  SizeOfCode           ', szcode)
    print('  SizeOfInitializedData', szinit)
    print('  SizeOfUninitData     ', szuninit)
    ep = struct.unpack_from('<I', d, opt + 16)[0]
    print('  AddressOfEntryPoint  ', hex(ep))
    print('  BaseOfCode           ', hex(struct.unpack_from('<I', d, opt + 20)[0]))
    if struct.unpack_from('<H', d, opt)[0] == 0x20B:
        print('  ImageBase            ', hex(struct.unpack_from('<Q', d, opt + 24)[0]))
        base_off = 32
    else:
        print('  ImageBase            ', hex(struct.unpack_from('<I', d, opt + 28)[0]))
        base_off = 28
    print('  SectionAlignment     ', hex(struct.unpack_from('<I', d, opt + 32)[0]))
    print('  FileAlignment        ', hex(struct.unpack_from('<I', d, opt + 36)[0]))
    osmaj, osmin = struct.unpack_from('<HH', d, opt + 40)
    print('  OSVersion  <-- 关键   ', f'{osmaj}.{osmin}')
    sub, submaj, submin = struct.unpack_from('<HHH', d, opt + 48)
    print('  SubsystemVersion     ', f'{sub}.{submaj}')
    print('  SizeOfImage          ', hex(struct.unpack_from('<I', d, opt + 56)[0]))
    print('  CheckSum             ', hex(struct.unpack_from('<I', d, opt + 64)[0]))
    print('  Subsystem            ', struct.unpack_from('<H', d, opt + 68)[0])
    print('  DllCharacteristics   ', hex(struct.unpack_from('<H', d, opt + 70)[0]))
    return d, e, coff, opt


a = dump(sys.argv[1])
b = dump(sys.argv[2])
print()
print('=== 逐字段比较 OPTIONAL HEADER (前 96 字节) ===')
oa = a[3]
ob = b[3]
diff = []
for off in range(0, 112):
    if a[0][oa + off] != b[0][ob + off]:
        diff.append(off)
print('有差异的字节偏移:', diff)
