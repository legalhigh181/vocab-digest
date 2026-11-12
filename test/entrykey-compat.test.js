/**
 * entryKey 老格式兼容（m01994 要求核实的兼容点）。
 *
 * 事实：T3 中途把 entryKey 的分隔符从 NUL（`ja\0词形\0读音\0词性`）改成了 `|`。
 * 落盘数据（旧 known.txt / decisions.json / 词表卡片 / 旧 digest.json）里仍是 NUL，
 * 所以三条状态必须还能认出来：
 *   1. 已掌握（known）
 *   2. 人工修订（decisions）
 *   3. 词表释义（cards / meaningsByEntryKey）+ 备份恢复
 * 另外要保证：归一**只动日文键**，英文键与裸词形一个字都不能改。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { jaEntryKey, normalizeJaEntryKey, parseJaEntryKey } from '../src/ja/entrykey.js';
import { digestJa } from '../src/ja/index.js';
import { buildTokenizer, hasTokenizerDependency } from '../src/ja/tokenizer.js';
import { applyDecisions, readDecisions } from '../src/run.js';
import { cardsToText, parseWordListText } from '../src/wordlists/import.js';
import { WordlistStore } from '../src/wordlists/store.js';

/** 老格式键：NUL 分隔 */
const LEGACY_NIHON = 'ja\u0000日本\u0000ニホン\u0000prop.';
const LEGACY_NIPPON = 'ja\u0000日本\u0000ニッポン\u0000prop.';
const LEGACY_UNKNOWN = 'ja\u0000Vtuber\u0000?\u0000prop.';

const hasDep = hasTokenizerDependency();
const skip = hasDep ? false : 'kuromoji 未安装';
let tokenizerPromise = null;
function tk() {
  if (!tokenizerPromise) tokenizerPromise = buildTokenizer();
  return tokenizerPromise;
}
const CFG = { lexicon: { minLen: 1, minFreq: 1 }, docx: { samplePerWord: 2, usagePerWord: 3 } };

function tempDir(label) {
  return mkdtempSync(join(tmpdir(), `vd-entrykey-${label}-`));
}

// ── 1. 归一函数本身 ─────────────────────────────────────────

test('entryKey · 老 NUL 键归一成 ja|，且幂等', () => {
  assert.equal(normalizeJaEntryKey(LEGACY_NIHON), 'ja|日本|ニホン|prop.');
  assert.equal(normalizeJaEntryKey(LEGACY_NIPPON), 'ja|日本|ニッポン|prop.');
  // 未知词 ：读音位是 `?`，归一后仍是 `?`（与「读音已知但为空」区分）
  assert.equal(normalizeJaEntryKey(LEGACY_UNKNOWN), 'ja|Vtuber|?|prop.');
  // 幂等
  const once = normalizeJaEntryKey(LEGACY_NIHON);
  assert.equal(normalizeJaEntryKey(once), once);
  assert.equal(normalizeJaEntryKey(jaEntryKey('日本', 'prop.', 'ニホン')), 'ja|日本|ニホン|prop.');
});

test('entryKey · 归一不动英文键、裸词形和坏键', () => {
  assert.equal(normalizeJaEntryKey('apple'), 'apple');
  assert.equal(normalizeJaEntryKey('Apple'), 'Apple');
  assert.equal(normalizeJaEntryKey('ja|日本|ニホン|prop.'), 'ja|日本|ニホン|prop.');
  // 段数不对（被 NUL 截断过）→ 原样返回，不造假键
  assert.equal(normalizeJaEntryKey('ja\u0000日本\u0000ニホン'), 'ja\u0000日本\u0000ニホン');
  assert.equal(normalizeJaEntryKey(''), '');
  assert.equal(normalizeJaEntryKey(null), '');
});

test('entryKey · 词形里含 | 的老键，归一后正确转义且能解析回来', () => {
  const legacy = 'ja\u0000A|B\u0000エービー\u0000n.';
  const key = normalizeJaEntryKey(legacy);
  assert.equal(key, 'ja|A\\|B|エービー|n.');
  assert.deepEqual(parseJaEntryKey(legacy), { word: 'A|B', reading: 'エービー', pos: 'n.' });
  assert.deepEqual(parseJaEntryKey(key), { word: 'A|B', reading: 'エービー', pos: 'n.' });
});

// ── 2. 已掌握（known）──────────────────────────────────────

test('known · 老 NUL 键写回时升级成 ja|', () => {
  const dir = tempDir('known');
  try {
    const store = new WordlistStore(dir);
    const created = store.create({ name: '日语表', language: 'ja', cards: [] });
    store.writeKnown(created.id, [LEGACY_NIHON, '日本']);
    const text = readFileSync(store.knownFileOf(created.id), 'utf8');
    assert.match(text, /^ja\|日本\|ニホン\|prop\.$/m, '老键要变成可打印格式');
    assert.doesNotMatch(text, /\u0000/, '落盘后不能再有 NUL');
    assert.match(text, /^日本$/m, '裸词形原样保留');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('known · 老 known.txt 仍然能把对应读音过滤掉，但不误伤另一个读音', { skip }, async () => {
  // kuromoji 给「日本」的读音是 ニッポン（已实测），所以：
  //   标了 ニッポン → 日本 应被过滤
  //   只标了 ニホン  → 日本 必须保留（同形异读不能连带）
  const frags = [{ text: '日本の勉強', t: 0, src: 'test.srt' }];
  const hit = await digestJa(frags, CFG, { tokenizer: await tk(), known: new Set([LEGACY_NIPPON]) });
  assert.equal(hit.items.find((it) => it.word === '日本'), undefined, '老键 ニッポン 应生效');

  const miss = await digestJa(frags, CFG, { tokenizer: await tk(), known: new Set([LEGACY_NIHON]) });
  assert.ok(miss.items.find((it) => it.word === '日本'), 'ニホン 不该连带过滤 ニッポン');
});

// ── 3. 人工修订（decisions）────────────────────────────────

test('decisions · 老 NUL 键读入后归一，仍然命中新格式词条', () => {
  const dir = tempDir('decisions');
  try {
    const file = join(dir, 'decisions.json');
    writeFileSync(file, JSON.stringify({
      [LEGACY_NIHON]: { meaning: '日本（人工修订）' },
      apple: { meaning: '苹果' },
    }, null, 2), 'utf8');

    const decisions = readDecisions(file);
    assert.equal(decisions['ja|日本|ニホン|prop.'].meaning, '日本（人工修订）');
    assert.equal(decisions.apple.meaning, '苹果', '英文键不能被改写');
    assert.equal(Object.keys(decisions).filter((k) => k.includes('\u0000')).length, 0);

    const out = applyDecisions({
      items: [
        { word: '日本', entryKey: 'ja|日本|ニホン|prop.', meaning: '' },
        { word: '日本', entryKey: 'ja|日本|ニッポン|prop.', meaning: '' },
      ],
    }, decisions);
    assert.equal(out.items[0].meaning, '日本（人工修订）', '同形异读只命中标了的那一条');
    assert.equal(out.items[1].meaning, '', '另一个读音不能被串上');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('decisions · 直接传老格式键（未过 readDecisions）也能命中', () => {
  const out = applyDecisions({
    items: [{ word: '日本', entryKey: 'ja|日本|ニホン|prop.', meaning: '' }],
  }, { [LEGACY_NIHON]: { meaning: '日本语' } });
  assert.equal(out.items[0].meaning, '日本语');
});

// ── 4. 词表卡片 + 释义 + 备份恢复 ──────────────────────────

test('cards · 老键卡片落盘即升级，释义表能用新键查到', () => {
  const dir = tempDir('cards');
  try {
    const store = new WordlistStore(dir);
    const created = store.create({
      name: '日语表',
      language: 'ja',
      cards: [{
        word: '日本', display: '日本', kind: 'word', language: 'ja',
        entryKey: LEGACY_NIHON, reading: 'ニホン', readingHiragana: 'にほん',
        senses: [{ pos: 'prop.', meaning: '日本' }],
      }],
    });
    const { cards } = store.cards(created.id);
    assert.equal(cards[0].entryKey, 'ja|日本|ニホン|prop.');

    const map = store.meaningsByEntryKey(created.id);
    assert.equal(map.get('ja|日本|ニホン|prop.')?.meaning, '日本');
    assert.equal(map.get(LEGACY_NIHON), undefined, '表里不应再留老键');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('backup · 老格式备份恢复后，卡片与掌握状态都升级到 ja|', () => {
  const dir = tempDir('restore');
  try {
    const store = new WordlistStore(dir);
    const payload = {
      schema: 2,
      meta: { id: 'old', name: '老备份', createdAt: '2026-01-01T00:00:00.000Z', language: 'ja' },
      cards: [{
        word: '日本', display: '日本', kind: 'word', language: 'ja',
        entryKey: LEGACY_NIPPON, reading: 'ニッポン',
        senses: [{ pos: 'prop.', meaning: '日本' }],
      }],
      known: [LEGACY_NIPPON],
    };
    const file = join(dir, 'old-backup.json');
    writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');

    const restored = store.restoreBackup(file, { name: '恢复表' });
    const { cards } = store.cards(restored.id);
    assert.equal(cards[0].entryKey, 'ja|日本|ニッポン|prop.');
    assert.deepEqual(store.known(restored.id), ['ja|日本|ニッポン|prop.']);
    assert.equal(existsSync(store.knownFileOf(restored.id)), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 5. 文本导入（#ja 元信息行）─────────────────────────────

test('import · #ja 行里的老 NUL 键导入后归一', () => {
  const text = [
    `#ja ${LEGACY_NIHON} 读音：ニホン 词性：prop. 假名：にほん`,
    '日本',
    'prop.',
    '日本',
  ].join('\n');
  const cards = parseWordListText(text).cards;
  assert.equal(cards.length, 1);
  assert.equal(cards[0].entryKey, 'ja|日本|ニホン|prop.');
});

test('import · 新格式 #ja 键走「文本转义层」，导出一圈能原样还原', () => {
  // 文本格式里 `|` 与 `\` 都会被转义（cardsToText 写、parseWordListText 读），
  // 所以词形里带 `|` 的键必须写两遍反斜杠，才不会被当成裸分隔符。
  const card = {
    word: 'A|B', display: 'A|B', kind: 'word', language: 'ja',
    entryKey: 'ja|A\\|B|エービー|n.', reading: 'エービー', pos: 'n.',
    senses: [{ pos: 'n.', meaning: '甲乙' }],
  };
  const text = cardsToText([card]);
  assert.match(text, /^#ja ja\\\|A\\\\\\\|B\\\|エービー\\\|n\./m, '导出时每个 \\| 都要再转义一层');

  const back = parseWordListText(text).cards;
  assert.equal(back.length, 1);
  assert.equal(back[0].entryKey, 'ja|A\\|B|エービー|n.', '往返不能丢转义信息');
  assert.deepEqual(parseJaEntryKey(back[0].entryKey), { word: 'A|B', reading: 'エービー', pos: 'n.' });
});
