/**
 * 编码体检：扫描项目里的文本文件，找出被 GBK/UTF-8 互相误读污染的痕迹。
 *
 * 为什么要有这个脚本：本项目的源文件曾经被「用 PowerShell 正则改含中文的 .js」
 * 整片写坏过，package.json 也被污染过。人是记不住的，交给脚本在每个 npm test 里跑一遍。
 *
 * 实现要点：JS 正则字面量里写 \uXXXX 时，字面量会把反斜杠原样保留进 pattern，
 * 所以指纹一律用 String.fromCharCode 构造，绝不在正则字面量里写转义。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/** 要扫描的目录（相对项目根） */
const SCAN_DIRS = ['src', 'bin', 'test', 'app', 'data', 'samples'];
/** 要扫描的根级文件 */
const SCAN_FILES = ['package.json', 'config.default.json', 'cordis.patch.yml', 'README.md'];
/** 扫描的扩展名 */
const EXTS = new Set(['.js', '.mjs', '.cjs', '.json', '.yml', '.yaml', '.md', '.txt', '.tsv', '.cmd', '.bat', '.html', '.css', '.srt']);

/** 按码点构造字符串 */
function chars(...cps) {
  return String.fromCharCode(...cps);
}

/**
 * 乱码汉字黑名单：GBK 双字节被当作 UTF-8 解码后留下的典型汉字。
 * 这些字在正常中文文本里几乎不出现；只有在同一个字命中 >= 2 行时才判污染。
 */
const MOJIBAKE_CHARS = new Set([
  0x93c2, 0x5a13, 0x7902, 0x7f02, 0x74e8, 0x93c4, 0x9443, 0x92bf,
  0x704f, 0x7ba0, 0x9365, 0x70ac, 0x6783, 0x932e, 0x7c37,
]);
/** 同一个字至少命中这么多行才判污染 */
const MIN_HITS_FOR_SINGLE = 2;

/**
 * 多字乱码序列：连续 3 个都是生僻组合，命中一次即可判定。
 */
const MOJIBAKE_SEQUENCES = [
  chars(0x9365, 0x70ac, 0x6783),
  chars(0x932e, 0x6f2b, 0x6c2e),
  chars(0x7487, 0x8bf2, 0x5f47),
  chars(0x9428, 0x7684, 0x6154),
];

/** 合法但不该出现的东西 */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

function walk(dir, out) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === '.git' || name === 'runs' || name === 'models') continue;
      walk(full, out);
    } else if (EXTS.has(extname(full).toLowerCase())) {
      out.push(full);
    }
  }
}

/**
 * 检查单个文件。
 * @returns {{file:string, enc:string, problems:Array<{kind:string, line:number, detail:string}>}}
 */
export function checkFile(file) {
  const problems = [];
  let buf;
  try { buf = readFileSync(file); } catch (e) {
    return { file, enc: '?', problems: [{ kind: 'unreadable', line: 0, detail: String(e.message) }] };
  }

  const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const body = hasBom ? buf.subarray(3) : buf;

  const text = body.toString('utf8');
  if (text.includes('\uFFFD')) {
    problems.push({ kind: 'invalid-utf8', line: 0, detail: '文件不是合法 UTF-8，含 U+FFFD 替换字符' });
    const gbk = new TextDecoder('gbk', { fatal: false }).decode(body);
    if (/[\u4e00-\u9fa5]/.test(gbk)) {
      problems.push({ kind: 'maybe-gbk', line: 0, detail: '按 GBK 解码能得到中文，可能是 GBK 编码的文件' });
    }
  }

  const lines = text.split(/\r\n|\r|\n/);
  const charHits = new Map();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const seq of MOJIBAKE_SEQUENCES) {
      if (line.includes(seq)) {
        problems.push({ kind: 'mojibake', line: i + 1, detail: line.trim().slice(0, 120) });
        break;
      }
    }
    for (const ch of line) {
      const cp = ch.codePointAt(0);
      if (!MOJIBAKE_CHARS.has(cp)) continue;
      if (!charHits.has(cp)) charHits.set(cp, new Set());
      charHits.get(cp).add(i + 1);
    }
    if (CONTROL_CHARS.test(line)) {
      problems.push({ kind: 'control-char', line: i + 1, detail: JSON.stringify(line.trim().slice(0, 80)) });
    }
  }
  for (const [cp, rows] of charHits) {
    if (rows.size < MIN_HITS_FOR_SINGLE) continue;
    const first = [...rows].sort((a, b) => a - b)[0];
    problems.push({
      kind: 'mojibake',
      line: first,
      detail: `可疑乱码字 ${chars(cp)} 在 ${rows.size} 行里重复出现：${(lines[first - 1] ?? '').trim().slice(0, 100)}`,
    });
  }
  return { file, enc: hasBom ? 'utf8-bom' : 'utf8', problems };
}

/** 扫描整个项目 */
export function scan(root = ROOT) {
  const files = [];
  for (const d of SCAN_DIRS) walk(join(root, d), files);
  for (const f of SCAN_FILES) {
    const full = join(root, f);
    if (existsSync(full)) files.push(full);
  }
  const results = files.map(checkFile);
  const problems = [];
  for (const r of results) for (const p of r.problems) problems.push({ file: relative(root, r.file) || r.file, ...p });
  return { ok: problems.length === 0, scanned: results.length, files: results, problems };
}

// 直接运行时输出报告
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const quiet = argv.includes('--quiet');
  const asJson = argv.includes('--json');
  const res = scan(ROOT);
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ ok: res.ok, scanned: res.scanned, problems: res.problems }, null, 2)}\n`);
  } else if (res.ok) {
    if (!quiet) process.stdout.write(`编码体检通过：${res.scanned} 个文件未发现乱码。\n`);
  } else {
    process.stdout.write(`编码体检失败：${res.problems.length} 处问题（扫描 ${res.scanned} 个文件）\n\n`);
    const byFile = new Map();
    for (const p of res.problems) {
      if (!byFile.has(p.file)) byFile.set(p.file, []);
      byFile.get(p.file).push(p);
    }
    for (const [file, list] of byFile) {
      process.stdout.write(`✗ ${file}\n`);
      for (const p of list.slice(0, 5)) {
        process.stdout.write(`    ${p.kind}${p.line ? ` @${p.line}` : ''}: ${p.detail}\n`);
      }
      if (list.length > 5) process.stdout.write(`    …另有 ${list.length - 5} 处\n`);
    }
    process.stdout.write('\n修法：用 write/edit 工具整文件重写，不要用 PowerShell 正则改含中文的文件。\n');
  }
  process.exitCode = res.ok ? 0 : 1;
}
