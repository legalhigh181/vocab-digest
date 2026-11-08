/**
 * 把 SEA blob 灌进 node.exe 的副本，得到自带运行时的 app exe。
 *
 * Node 的 SEA 在 PE 里预留了一个 fuse 哨兵字符串：
 *   NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
 * 哨兵的**最后一个字节**置为 '1'(0x31) 表示「已注入」，此时运行时会在
 * 可执行文件末尾的 PE 节之后找 SEA blob。
 *
 * 这里手工完成 postject 做的事：改 fuse + 在文件末尾追加 PE 节头与 blob。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const SENTINEL = Buffer.from(FUSE + '\0', 'latin1');

export function injectSea(exePath, blobPath) {
  const data = readFileSync(exePath);
  const blob = readFileSync(blobPath);

  const at = data.indexOf(SENTINEL);
  if (at < 0) {
    // 哨兵后面不一定紧跟着 \0，退回「只找字符串本身」
    const loose = data.indexOf(FUSE, 0, 'latin1');
    if (loose < 0) throw new Error('找不到 SEA fuse 哨兵，这个 exe 不支持 SEA');
    data[loose + FUSE.length] = 0x31;
    return continueWith(data, blob, loose + FUSE.length, exePath);
  }

  // 1) 点亮 fuse：把哨兵最后一个字节（原本是 \0）改成 '1'
  data[at + FUSE.length] = 0x31;
  console.log('fuse lit at', at + FUSE.length, '->', String.fromCharCode(data[at + FUSE.length]));
  return continueWith(data, blob, at + FUSE.length, exePath);
}

function continueWith(data, blob, fuseAt, exePath) {

  // 2) 定位 PE 结构
  const eLfanew = data.readUInt32LE(0x3c);
  if (data.toString('latin1', eLfanew, eLfanew + 4) !== 'PE\0\0') throw new Error('不是 PE 文件');
  const coff = eLfanew + 4;
  const numSec = data.readUInt16LE(coff + 2);
  const sizeOpt = data.readUInt16LE(coff + 16);
  const opt = coff + 20;
  const secTable = opt + sizeOpt;
  const fileAlign = data.readUInt32LE(opt + 36);
  const sectAlign = data.readUInt32LE(opt + 32);

  // 3) 计算新节的放置位置
  let lastRawEnd = 0;
  let lastVaEnd = 0;
  for (let i = 0; i < numSec; i += 1) {
    const s = secTable + 40 * i;
    const vsize = data.readUInt32LE(s + 8);
    const vaddr = data.readUInt32LE(s + 12);
    const rawsize = data.readUInt32LE(s + 16);
    const rawptr = data.readUInt32LE(s + 20);
    lastRawEnd = Math.max(lastRawEnd, rawptr + rawsize);
    lastVaEnd = Math.max(lastVaEnd, vaddr + Math.max(vsize, rawsize));
  }
  const align = (v, a) => Math.ceil(v / a) * a;

  const rawPtr = align(Math.max(lastRawEnd, data.length), fileAlign);
  const va = align(lastVaEnd, sectAlign);
  console.log('numSec', numSec, 'fileAlign', fileAlign, 'sectAlign', sectAlign, 'rawPtr', rawPtr, 'va', va);

  // 4) 追加节头（节表后面就是空的，够放 40 字节）
  const hdr = Buffer.alloc(40);
  hdr.write('.sea\0\0\0\0', 0, 'latin1');
  hdr.writeUInt32LE(blob.length, 8); // VirtualSize
  hdr.writeUInt32LE(va, 12); // VirtualAddress
  hdr.writeUInt32LE(align(blob.length, fileAlign), 16); // SizeOfRawData
  hdr.writeUInt32LE(rawPtr, 20); // PointerToRawData
  hdr.writeUInt32LE(0x40000040, 36); // 已初始化数据 | 可读
  const padded = Buffer.concat([data, Buffer.alloc(Math.max(0, rawPtr - data.length))]);
  hdr.copy(padded, secTable + 40 * numSec);

  // 5) 节数 +1
  padded.writeUInt16LE(numSec + 1, coff + 2);

  // 6) SizeOfImage 覆盖到新节
  const sizeImage = padded.readUInt32LE(opt + 56);
  padded.writeUInt32LE(Math.max(sizeImage, align(va + blob.length, sectAlign)), opt + 56);

  // 7) 校验和清零
  padded.writeUInt32LE(0, opt + 64);

  // 8) 写入 blob
  writeFileSync(exePath, Buffer.concat([padded, blob]));
  return { rawPtr, va, size: blob.length };
}

if (process.argv[1] && process.argv[1].endsWith('inject-sea.mjs')) {
  const [exe, blob] = process.argv.slice(2);
  const r = injectSea(exe, blob);
  console.log('SEA injected:', r);
}
