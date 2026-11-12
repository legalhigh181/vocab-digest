/**
 * 迁移工具：把落盘数据里的**老 NUL 格式** entryKey 升级成 `ja|词形|读音|词性`。
 *
 * 背景：T3 中途把 entryKey 的分隔符从 `\u0000` 改成了 `|`（原因见 src/ja/entrykey.js）。
 * 引擎读取时会自动归一（`normalizeJaEntryKey`），所以不跑这个工具也能用；
 * 这个工具是给「想把文件本身也清理干净」的场景准备的——比如要人工核对、
 * 或者要交给别的工具处理。
 *
 * 覆盖三类用户状态文件：
 *   - `decisions.json`（人工修订，键是 entryKey 或裸词形）
 *   - `known.txt`（已掌握，一行一个 entryKey/词形）
 *   - `cards.json`（词表卡片里的 `cards[].entryKey`）
 *
 * 默认只报告不写盘；加 `--apply` 才真正改。改之前每个文件先备份成 `<file>.bak-entrykey`。
 *
 * 用法：
 *   node tools/migrate-entrykey.mjs                       # 扫 data/ 与 runs/，只报告
 *   node tools/migrate-entrykey.mjs --apply               # 真正写盘
 *   node tools/migrate-entrykey.mjs <目录> [--apply]       # 扫指定目录
 *   node tools/migrate-entrykey.mjs --json                # 机器可读输出
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { normalizeJaEntryKey, LEGACY_JA_KEY_PREFIX } from '../src/ja/entrykey.js';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const asJson = args.includes('--json');
const dirArg = args.find((a) => !a.startsWith('--'));
const targets = dirArg
  ? [resolve(dirArg)]
  : [resolve(ROOT, 'data'), resolve(ROOT, 'runs')];

const hasLegacy = (s) => typeof s === 'string' && s.includes(LEGACY_JA_KEY_PREFIX);

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

const report = [];

function backup(file) {
  const bak = `${file}.bak-entrykey`;
  if (!existsSync(bak)) copyFileSync(file, bak);
  return bak;
}

/** decisions.json：对象键归一；老键同名归一后若撞车，保留后写的那条并记一笔 */
function migrateDecisions(file, text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const keys = Object.keys(data).filter(hasLegacy);
  if (!keys.length) return null;
  const out = {};
  const merged = [];
  for (const [k, v] of Object.entries(data)) {
    const nk = normalizeJaEntryKey(k);
    if (nk !== k && out[nk] !== undefined) merged.push({ from: k, to: nk });
    out[nk] = v;
  }
  const next = `${JSON.stringify(out, null, 2)}\n`;
  return { file, kind: 'decisions', count: keys.length, merged, next };
}

/** known.txt：一行一个键；保留注释与空行，只换有老键的行 */
function migrateKnown(file, text) {
  const lines = text.split('\n');
  let count = 0;
  const next = lines.map((line) => {
    const m = /^(\s*)(\S.*?)(\s*)$/.exec(line);
    if (!m || !hasLegacy(m[2])) return line;
    count += 1;
    return `${m[1]}${normalizeJaEntryKey(m[2])}${m[3]}`;
  }).join('\n');
  if (!count) return null;
  return { file, kind: 'known', count, merged: [], next };
}

/** cards.json：{hash, cards:[{entryKey}]}；hash 改完需要重算，否则 store 会认为文件被篡改 */
async function migrateCards(file, text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const cards = Array.isArray(data?.cards) ? data.cards : null;
  if (!cards) return null;
  let count = 0;
  const nextCards = cards.map((c) => {
    if (!c || !hasLegacy(c.entryKey)) return c;
    count += 1;
    return { ...c, entryKey: normalizeJaEntryKey(c.entryKey) };
  });
  if (!count) return null;
  const { cardsHash } = await import('../src/wordlists/import.js');
  const next = `${JSON.stringify({ ...data, hash: cardsHash(nextCards), cards: nextCards }, null, 2)}\n`;
  return { file, kind: 'cards', count, merged: [], next };
}

for (const dir of targets) {
  for (const file of walk(dir)) {
    const name = basename(file).toLowerCase();
    if (!name.endsWith('.json') && !name.endsWith('.txt')) continue;
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (!hasLegacy(text)) continue;
    let res = null;
    if (name === 'decisions.json') res = migrateDecisions(file, text);
    else if (name === 'known.txt') res = migrateKnown(file, text);
    else if (name === 'cards.json') res = await migrateCards(file, text);
    if (!res) continue;
    if (apply) {
      res.backup = backup(file);
      writeFileSync(file, res.next, 'utf8');
    }
    delete res.next;
    report.push(res);
  }
}

const total = report.reduce((n, r) => n + r.count, 0);
if (asJson) {
  process.stdout.write(`${JSON.stringify({ apply, total, files: report }, null, 2)}\n`);
} else if (!report.length) {
  process.stdout.write(`没有需要迁移的老格式 entryKey（扫了 ${targets.join(' 与 ')}）\n`);
} else {
  process.stdout.write(`${apply ? '已迁移' : '需要迁移'} ${total} 个老格式键，涉及 ${report.length} 个文件：\n`);
  for (const r of report) {
    const extra = r.merged?.length ? `（${r.merged.length} 个键归一后与已有键撞车，后者覆盖）` : '';
    process.stdout.write(`  [${r.kind}] ${r.count} 处${extra}  ${r.file}${r.backup ? ` → 备份 ${basename(r.backup)}` : ''}\n`);
  }
  if (!apply) process.stdout.write('这是预演，没有写盘；确认无误后加 --apply。\n');
}
