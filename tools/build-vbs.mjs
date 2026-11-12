/**
 * 把 tools/*.vbs 源码（UTF-8）转成 cscript 能读的 UTF-16LE + 单个 BOM。
 *
 * 为什么需要这个：VBScript 按 ANSI 或 UTF-16 读文件，UTF-8 无 BOM 会把中文读成
 * 乱码，直接编译报错。而反复「读 utf16le → 再写 utf16le」会把 BOM 叠加成多个。
 * 所以统一从 UTF-8 源码出发，每次重新生成，保证只有一个 BOM。
 */
import fs from 'node:fs';

const pairs = process.argv.slice(2);
if (!pairs.length) {
  console.log('用法: node tools/build-vbs.mjs <源.vbs> <目标.vbs> [...]');
  process.exit(1);
}

for (let i = 0; i < pairs.length; i += 2) {
  const src = pairs[i];
  const dst = pairs[i + 1];
  let s = fs.readFileSync(src, 'utf8');
  // 去掉可能残留的 BOM
  s = s.replace(/^\uFEFF+/, '');
  // 统一换行
  s = s.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  const body = Buffer.from(s, 'utf16le');
  const bom = Buffer.from([0xff, 0xfe]);
  fs.writeFileSync(dst, Buffer.concat([bom, body]));
  console.log(`${dst}  <- ${src}  (${(bom.length + body.length)} 字节, UTF-16LE 单 BOM)`);
}
