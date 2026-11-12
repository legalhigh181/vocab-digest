// 体检：本机真实数据里 entryKey 用的是 `ja|` 还是老的 NUL 分隔 `ja\0`。
// 只读，不改任何文件。用法：node tools/probe-entrykey-format.mjs [--json]
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const asJson = process.argv.includes('--json');

/** 递归列出文件（跳过 node_modules/.git/.asr-stage） */
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '.git' || ent.name.startsWith('.asr-')) continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.isFile()) out.push(p);
  }
  return out;
}

const stats = { pipe: 0, nul: 0, other: 0, files: [], samples: [] };

/** 从一段文本里数出 ja| 与 ja\0 开头的键 */
function countInText(file, text) {
  const pipe = (text.match(/"ja\|/g) ?? []).length + (text.match(/^ja\|/gm) ?? []).length;
  const nulEscaped = (text.match(/"ja\\u0000/g) ?? []).length + (text.match(/^ja\\u0000/gm) ?? []).length;
  const nulRaw = (text.match(/"ja\x00/g) ?? []).length + (text.match(/^ja\x00/gm) ?? []).length;
  const nul = nulEscaped + nulRaw;
  if (!pipe && !nul) return null;
  stats.pipe += pipe;
  stats.nul += nul;
  const rec = { file, pipe, nul };
  stats.files.push(rec);
  if (nul && stats.samples.length < 8) {
    const m = text.match(/ja\\u0000[^"\n]{0,40}|ja\x00[^"\n]{0,40}/);
    if (m) stats.samples.push({ file, sample: m[0].replace(/\x00/g, '\\0') });
  }
  return rec;
}

const TARGET_DIRS = [
  'data/wordlists',
  'data/ja',
  'data/known',
  'runs',
  'samples',
  // 备份目录（在工程根的同级）
  '../vocab-digest-词表备份-20261110-2330/data/wordlists',
  '../vocab-digest-词表备份-20261110-2355/data/wordlists',
  '../vocab-digest-词表备份-20261110-2145/data/wordlists',
  '../vocab-digest-我的词表备份-20261108/data/wordlists',
];

for (const rel of TARGET_DIRS) {
  const dir = resolve(ROOT, rel);
  for (const f of walk(dir)) {
    if (!/\.(json|txt|tsv|csv|md)$/i.test(f)) continue;
    let text = '';
    try {
      text = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    countInText(f.replace(ROOT + '\\', '').replace(ROOT + '/', ''), text);
  }
}

// 引擎现在到底输出哪种？直接问一次
const { jaEntryKey, parseJaEntryKey } = await import('../src/ja/index.js');
const engineKey = jaEntryKey('日本', 'prop.', 'ニホン');
const engineUnknown = jaEntryKey('Vtuber', 'prop.', '', true);
const enginePipeInWord = jaEntryKey('A|B', 'n.', 'エービー');

const report = {
  engineProduces: { normal: engineKey, unknown: engineUnknown, pipeInWord: enginePipeInWord },
  engineParses: {
    normal: parseJaEntryKey(engineKey),
    legacy: parseJaEntryKey('ja\u0000日本\u0000ニホン\u0000prop.'),
  },
  onDisk: stats,
  verdict: stats.nul > 0 ? '本机落盘数据里存在老 NUL 格式 entryKey（需要兼容/迁移）' : '落盘数据全是 ja| 或没有日文键',
};

if (asJson) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} else {
  process.stdout.write(`引擎输出：${engineKey} / ${engineUnknown} / ${enginePipeInWord}\n`);
  process.stdout.write(`解析老键：${JSON.stringify(parseJaEntryKey('ja\u0000日本\u0000ニホン\u0000prop.'))}\n`);
  process.stdout.write(`落盘扫描：ja| ${stats.pipe} 处，ja\\0 ${stats.nul} 处，涉及 ${stats.files.length} 个文件\n`);
  for (const f of stats.files) {
    process.stdout.write(`  ${f.pipe ? `ja| ${f.pipe}` : ''}${f.pipe && f.nul ? ' / ' : ''}${f.nul ? `ja\\0 ${f.nul}` : ''}  ${f.file}\n`);
  }
  for (const s of stats.samples) process.stdout.write(`  样本 ${s.file}: ${s.sample}\n`);
  process.stdout.write(`结论：${report.verdict}\n`);
}
