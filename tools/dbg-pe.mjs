/**
 * 调试：把 node.exe 的 PE 结构打印出来，看清楚节表和可选头的真实位置。
 */
import { readFileSync } from 'node:fs';

const f = process.argv[2];
const d = readFileSync(f);
const e = d.readUInt32LE(0x3c);
const coff = e + 4;
const machine = d.readUInt16LE(coff);
const nsec = d.readUInt16LE(coff + 2);
const sizeOpt = d.readUInt16LE(coff + 16);
const opt = coff + 20;
const magic = d.readUInt16LE(opt);
const is64 = magic === 0x20b;
const secTable = opt + sizeOpt;

console.log('e_lfanew', e, 'machine', '0x' + machine.toString(16));
console.log('nsec', nsec, 'sizeOpt', sizeOpt, 'opt', opt, 'magic', '0x' + magic.toString(16), is64 ? '(PE32+)' : '(PE32)');
console.log('sectAlign', d.readUInt32LE(opt + 32), 'fileAlign', d.readUInt32LE(opt + 36));
console.log('SizeOfImage', d.readUInt32LE(opt + 56), 'SizeOfHeaders', d.readUInt32LE(opt + 60));
const ddCount = d.readUInt32LE(opt + (is64 ? 108 : 92));
const ddOff = opt + (is64 ? 112 : 96);
console.log('NumberOfRvaAndSizes', ddCount, 'DataDir at', ddOff);
const rsrc = ddOff + 16;
console.log('  resource dir RVA', d.readUInt32LE(rsrc), 'size', d.readUInt32LE(rsrc + 4));
console.log('secTable', secTable, ' (file len ' + d.length + ')');
console.log('\n[节表] idx  name        vsize      vaddr      rawsize    rawptr');
for (let i = 0; i < nsec; i++) {
  const s = secTable + 40 * i;
  const name = d.toString('latin1', s, s + 8).replace(/\0+$/, '');
  console.log(
    String(i).padStart(4),
    name.padEnd(10),
    String(d.readUInt32LE(s + 8)).padStart(10),
    String(d.readUInt32LE(s + 12)).padStart(10),
    String(d.readUInt32LE(s + 16)).padStart(10),
    String(d.readUInt32LE(s + 20)).padStart(10),
  );
}
