/**
 * 本地英汉词典（ECDICT）。
 *
 * ECDICT 是 skywind3000 的《简明英汉字典增强版》，CSV 约 66MB，MIT 协议。
 * 我们只用它做一件事：**查词给中文释义**。
 *
 * 实现要点（踩过的坑）：
 *   1. translation 字段里的换行是**字面的 `\n` 两个字符**（反斜杠+n），不是真换行。
 *      所以文件可以按真实换行（0x0a）切行，一行一个词条。
 *   2. CSV 有引号包裹的字段（内含逗号），但**引号字段绝不会跨行**——
 *      所以直接按 0x0a 切行是安全的，不需要引号状态机。
 *   3. 建索引时**按字节扫**，绝不先 toString 再用字符下标去算偏移 ——
 *      中文字符占 3 字节，字符下标和字节偏移对不上（这个 bug 会让所有查词错位）。
 *   4. 66MB 全量常驻内存没必要：只建 word → 字节偏移 的索引，查词时读那一行。
 *   5. 词典是可选的：文件不存在时 lookup 返回 null，整个工具照常工作。
 */
import { existsSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 剑桥英汉（简体）词条页 */
const CAMBRIDGE_BASE = 'https://dictionary.cambridge.org/dictionary/english-chinese-simplified/';

/**
 * 给一个词生成剑桥词典链接。多词短语用 + 连接（剑桥的查询约定）。
 * @param {string} word
 * @returns {string} 空字符串表示这个词不适合外链
 */
export function cambridgeUrl(word) {
  const w = String(word ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!w) return '';
  if (!/^[a-z][a-z'’\- ]*[a-z]?$/.test(w)) return '';
  const slug = w.replace(/’/g, "'").replace(/ /g, '+');
  return CAMBRIDGE_BASE + encodeURIComponent(slug).replace(/%2B/g, '+');
}

/** 词典文件位置：<dataDir>/ecdict.csv */
export function ecdictPath(dataDir) {
  return join(dataDir, 'ecdict.csv');
}

/**
 * 把 ECDICT 的 translation 收拾成一行可读的中文释义。
 *
 * CSV 里字段内的换行是**字面的 `\n` 两个字符**（反斜杠+n），不是真换行，
 * 所以这里既要按真换行切，也要按字面 `\n` 切。
 * 行首带 `[网络]` / `[计]` / `[医]` 这类领域标记的行优先丢弃（口语场景用不上）。
 */
export function tidyTranslation(raw) {
  if (!raw) return '';
  const lines = String(raw)
    .split(/\\n|\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!lines.length) return '';
  const plain = lines.filter((l) => !/^\[[^\]]+\]/.test(l));
  const picked = (plain.length ? plain : lines)
    .map((l) => l.replace(/\[[^\]]+\]/g, '').trim())
    .filter(Boolean);
  const out = picked.join('；').replace(/；{2,}/g, '；').replace(/^；|；$/g, '');
  return out.slice(0, 240);
}

/** 从一行 CSV 记录里取字段（引号内的逗号不拆；"" 表示一个引号） */
export function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = false;
      } else cur += ch;
    } else if (ch === '"') inQuote = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** 列序号（见 CSV 表头顺序） */
const COL = { word: 0, phonetic: 1, translation: 3, pos: 4 };

const LF = 0x0a;
const CR = 0x0d;
const COMMA = 0x2c;
const QUOTE = 0x22;

/**
 * 取一行里第 0 个字段（word）的原始字节。不需要引号状态机：
 * word 字段若被引号包裹，去掉首尾引号即可。
 */
function fieldZero(buf, start, end) {
  let i = start;
  if (i < end && buf[i] === QUOTE) {
    i += 1;
    let close = i;
    while (close < end && !(buf[close] === QUOTE && (close + 1 >= end || buf[close + 1] !== QUOTE))) close += 1;
    return buf.toString('utf8', i, close).trim();
  }
  let stop = i;
  while (stop < end && buf[stop] !== COMMA) stop += 1;
  return buf.toString('utf8', i, stop).trim();
}

export class Ecdict {
  constructor(file) {
    this.file = file;
    this.fd = -1;
    this.index = new Map();   // 小写词 → 行首字节偏移
    this.ready = false;
    this.size = 0;
    this.header = null;
  }

  /** 建索引：按字节扫，只在行首记偏移 */
  open() {
    if (!existsSync(this.file)) return false;
    this.size = statSync(this.file).size;
    this.fd = openSync(this.file, 'r');

    const CHUNK = 8 * 1024 * 1024;
    const buf = Buffer.allocUnsafe(CHUNK);
    let pos = 0;        // 当前块在文件里的字节起点
    let lineStart = 0;  // 当前行首的绝对字节偏移
    let first = true;   // 第一行是表头

    while (pos < this.size) {
      const want = Math.min(CHUNK, this.size - pos);
      const n = readSync(this.fd, buf, 0, want, pos);
      if (!n) break;
      let i = 0;
      while (i < n) {
        // 找本块内下一个换行
        let j = i;
        while (j < n && buf[j] !== LF) j += 1;
        if (j >= n) break;               // 行尾跨块 → 退出，下一轮从 pos+i 续读
        const end = j > i && buf[j - 1] === CR ? j - 1 : j;
        if (first) {
          this.header = buf.toString('utf8', i, end);
          first = false;
        } else if (end > i) {
          const word = fieldZero(buf, i, end);
          if (word) {
            const key = word.toLowerCase();
            if (!this.index.has(key)) this.index.set(key, lineStart);
            // ECDICT 里有 'hood / 'tween 这类带前导撇号的，也收一个去撇号的别名
            if (key.startsWith("'") && key.length > 1 && !this.index.has(key.slice(1))) {
              this.index.set(key.slice(1), lineStart);
            }
          }
        }
        lineStart = pos + j + 1;
        i = j + 1;
      }
      pos += i;   // 只推进到已完整处理的位置
      if (i === 0) break;  // 防御：单行远超块大小
    }
    this.ready = true;
    return true;
  }

  close() {
    if (this.fd >= 0) { closeSync(this.fd); this.fd = -1; }
  }

  /** 读指定字节偏移处的一整行 */
  readAt(offset) {
    const MAX = 64 * 1024;
    const buf = Buffer.allocUnsafe(MAX);
    const n = readSync(this.fd, buf, 0, MAX, offset);
    if (!n) return null;
    let end = buf.indexOf(LF, 0);
    if (end < 0 || end > n) end = n;
    if (end > 0 && buf[end - 1] === CR) end -= 1;
    return buf.toString('utf8', 0, end);
  }

  /**
   * 查一个词。返回 { word, phonetic, translation, pos } 或 null。
   */
  lookup(word) {
    if (!this.ready) return null;
    const w = String(word ?? '').trim();
    if (!w) return null;
    const hit = this.index.get(w.toLowerCase());
    if (hit == null) return null;
    const line = this.readAt(hit);
    if (!line) return null;
    const f = parseCsvLine(line);
    // 偏移错了会查出一行不相干的词 —— 用 word 字段自校验
    if (String(f[COL.word] ?? '').trim().toLowerCase() !== w.toLowerCase()) return null;
    const translation = tidyTranslation(f[COL.translation]);
    if (!translation) return null;
    return {
      word: f[COL.word],
      phonetic: (f[COL.phonetic] ?? '').trim(),
      translation,
      pos: (f[COL.pos] ?? '').trim(),
    };
  }

  get count() {
    return this.index.size;
  }
}

let cached = null;

/** 单例：同一个进程里只建一次索引 */
export function openEcdict(file) {
  if (cached && cached.file === file) return cached;
  cached = new Ecdict(file);
  cached.open();
  return cached;
}
