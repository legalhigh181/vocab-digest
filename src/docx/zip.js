/**
 * zip 写入 / 读取（最小实现，deflate）。docx 就是一个 zip 包。
 *
 * 只支持 store / deflate、无 ZIP64（docx 不会超过 4GB）。
 * 时间戳可固定，保证同输入生成字节一致的包。
 */
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

function dosDateTime(date) {
  const y = date.getUTCFullYear();
  const mo = date.getUTCMonth() + 1;
  const d = date.getUTCDate();
  const h = date.getUTCHours();
  const mi = date.getUTCMinutes();
  const s = date.getUTCSeconds();
  return {
    date: ((y - 1980) << 9) | (mo << 5) | d,
    time: (h << 11) | (mi << 5) | Math.floor(s / 2),
  };
}

/**
 * @param {Array<{name:string, data:Buffer|string, compress?:boolean}>} entries
 * @param {object} opts { date?: Date }
 */
export function makeZip(entries, opts = {}) {
  const now = opts.date ?? new Date();
  const { date: dosDate, time: dosTime } = dosDateTime(now);
  const names = entries.map((e) => e.name);
  if (new Set(names).size !== names.length) throw new Error('zip: entry name duplicated');

  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
    const compress = entry.compress !== false;
    const body = compress ? deflateRawSync(raw, { level: 9 }) : raw;
    const crc = crc32(raw) >>> 0;
    const method = compress ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, body);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(dosTime, 12);
    cen.writeUInt16LE(dosDate, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cen, nameBuf]));

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, end]);
}

/**
 * 读取 zip（按中央目录，支持 store / deflate），逐条校验 CRC。
 * @returns {Map<string, Buffer>}
 */
export function readZip(buf) {
  // 找中央目录结束标记
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: EOCD not found');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();

  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip: bad central header');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error(`zip: bad local header ${name}`);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const body = buf.subarray(dataStart, dataStart + csize);
    let data;
    if (method === 8) {
      try {
        data = inflateRawSync(body);
      } catch (e) {
        throw new Error(`zip: deflate corrupted ${name} (${e.message})`);
      }
    } else {
      data = Buffer.from(body);
    }
    if (data.length !== usize) throw new Error(`zip: size mismatch ${name}`);
    if ((crc32(data) >>> 0) !== crc) throw new Error(`zip: CRC mismatch ${name}`);
    out.set(name, data);
  }
  return out;
}
