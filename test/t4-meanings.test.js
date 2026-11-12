/**
 * T4 验收测试：本地释义查询 + 三层优先级 + 三种状态 + 字段往返保留。
 *
 * 用户 m07451 列出的验收点：
 *   1. 本地 JSON／TSV 查询，以及同形异读词的匹配结果
 *   2. 人工修订 > 当前词表 > provider 的冲突测试
 *   3. 未配置、未命中、加载失败三种状态；缺释义仍可导出
 *   4. 卡片 → 备份恢复 → 导出导入 → 重渲染后的字段保留（读音/entryKey/释义语言来源/掌握状态）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createFileProvider, createNoopProvider, meaningWarnings, parseMeaningsJson, parseMeaningsTsv, resolveMeaning,
} from '../src/meanings.js';
import { WordlistStore } from '../src/wordlists/store.js';
import { cardsToText } from '../src/wordlists/import.js';

function tmp() {
  return mkdtempSync(join(tmpdir(), 't4-'));
}

// ══════════════════════════════════════════════════════════
// 1. 本地 JSON / TSV 查询 + 同形异读
// ══════════════════════════════════════════════════════════

test('T4 · JSON：解析并命中（词形+读音+词性 三者匹配）', () => {
  const dir = tmp();
  const file = join(dir, 'meanings.json');
  writeFileSync(file, JSON.stringify({
    schema: 'vocab-digest-meanings/1',
    language: 'ja',
    meaningLanguage: 'zh',
    entries: [
      { word: '日本', reading: 'ニホン', pos: 'prop.', meaning: '日本' },
      { word: '日本', reading: 'ニッポン', pos: 'prop.', meaning: '日本（强调）' },
      { word: '猫', reading: 'ネコ', pos: 'n.', meaning: '猫' },
    ],
  }), 'utf8');

  const p = createFileProvider({ file });
  assert.equal(p.status, 'ok');
  assert.equal(p.count, 3);

  assert.equal(p.lookup({ word: '日本', reading: 'ニホン', pos: 'prop.' }).meaning, '日本');
  assert.equal(p.lookup({ word: '日本', reading: 'ニッポン', pos: 'prop.' }).meaning, '日本（强调）');
  assert.equal(p.lookup({ word: '猫', reading: 'ネコ', pos: 'n.' }).meaning, '猫');
});

test('T4 · 同形异读：读音对不上时不返回另一条释义（不串项）', () => {
  const dir = tmp();
  const file = join(dir, 'meanings.json');
  writeFileSync(file, JSON.stringify({
    entries: [
      { word: '日本', reading: 'ニホン', pos: 'prop.', meaning: '日本' },
      { word: '日本', reading: 'ニッポン', pos: 'prop.', meaning: '日本（强调）' },
    ],
  }), 'utf8');
  const p = createFileProvider({ file });

  // 读音既不是ニホン也不是ニッポン → 必须未命中，不能随便给一条
  const r = p.lookup({ word: '日本', reading: 'ジッポン', pos: 'prop.' });
  assert.equal(r.ok, true);
  assert.equal(r.found, false, '同形异读不匹配时必须 found=false');
  assert.equal(r.meaning, '');
});

test('T4 · 同形异读：省略读音时按「通配」兜底（只有无歧义时才给）', () => {
  const dir = tmp();
  const file = join(dir, 'meanings.json');
  writeFileSync(file, JSON.stringify({
    entries: [
      // 只登记一条、且没写读音 → 通配
      { word: '今日', pos: 'n.', meaning: '今天' },
    ],
  }), 'utf8');
  const p = createFileProvider({ file });
  const r = p.lookup({ word: '今日', reading: 'キョウ', pos: 'n.' });
  assert.equal(r.found, true);
  assert.equal(r.meaning, '今天');
});

test('T4 · TSV：制表符分隔 + 注释行 + 双空格简写', () => {
  const tsv = [
    '# 词形\t释义\t读音\t词性\t释义语言',
    '勉強\t学习\tベンキョウ\tv.\tzh',
    '',
    '走る  跑  ハシル   v.   zh',
  ].join('\n');
  const recs = parseMeaningsTsv(tsv);
  assert.equal(recs.length, 2);
  assert.equal(recs[0].word, '勉強');
  assert.equal(recs[0].meaning, '学习');
  assert.equal(recs[0].reading, 'ベンキョウ');
  assert.equal(recs[1].word, '走る');
  assert.equal(recs[1].reading, 'ハシル');
});

test('T4 · TSV 文件：provider 能直接查', () => {
  const dir = tmp();
  const file = join(dir, 'meanings.tsv');
  writeFileSync(file, '猫\t猫\tネコ\tn.\tzh\n犬\t狗\tイヌ\tn.\tzh\n', 'utf8');
  const p = createFileProvider({ file });
  assert.equal(p.status, 'ok');
  assert.equal(p.lookup({ word: '犬', reading: 'イヌ', pos: 'n.' }).meaning, '狗');
});

test('T4 · 结果必须标明释义语言与来源', () => {
  const dir = tmp();
  const file = join(dir, 'meanings.json');
  writeFileSync(file, JSON.stringify({ meaningLanguage: 'zh', entries: [{ word: '猫', meaning: '猫' }] }), 'utf8');
  const p = createFileProvider({ file });
  const r = p.lookup({ word: '猫' });
  assert.equal(r.meaningLanguage, 'zh', '释义语言必须标出');
  assert.equal(r.source, 'provider', '来源必须标出');
  assert.ok(r.sourceDetail.endsWith('meanings.json'));
});

test('T4 · JSON 语法错误抛出可识别错误', () => {
  assert.throws(() => parseMeaningsJson('{ not json'), (e) => e.code === 'MEANINGS_LOAD_FAILED');
});

// ══════════════════════════════════════════════════════════
// 2. 三层优先级
// ══════════════════════════════════════════════════════════

function providerWith(map) {
  return {
    status: 'ok',
    error: '',
    describe: () => 'test provider',
    lookup: (q) => (map[q.word]
      ? { ok: true, found: true, meaning: map[q.word], meaningLanguage: 'zh', source: 'provider', sourceDetail: 'test.json' }
      : { ok: true, found: false, meaning: '', meaningLanguage: '', source: 'provider', sourceDetail: 'test.json' }),
  };
}

test('T4 · 优先级：人工修订 > 词表 > provider', () => {
  const p = providerWith({ 猫: 'provider的猫' });
  const all = resolveMeaning({
    word: '猫', revision: { meaning: '人工的猫' }, wordlist: { meaning: '词表的猫' }, provider: p,
  });
  assert.equal(all.meaning, '人工的猫');
  assert.equal(all.meaningSource, 'revision');

  const noRev = resolveMeaning({ word: '猫', wordlist: { meaning: '词表的猫' }, provider: p });
  assert.equal(noRev.meaning, '词表的猫');
  assert.equal(noRev.meaningSource, 'wordlist');

  const onlyProvider = resolveMeaning({ word: '猫', provider: p });
  assert.equal(onlyProvider.meaning, 'provider的猫');
  assert.equal(onlyProvider.meaningSource, 'provider');
});

test('T4 · 优先级：空字符串不算「有释义」，会往下走', () => {
  const p = providerWith({ 猫: 'provider的猫' });
  const r = resolveMeaning({
    word: '猫', revision: { meaning: '   ' }, wordlist: { meaning: '' }, provider: p,
  });
  assert.equal(r.meaning, 'provider的猫');
  assert.equal(r.meaningSource, 'provider');
});

test('T4 · 优先级：全都没有时 meaningSource = none', () => {
  const p = providerWith({});
  const r = resolveMeaning({ word: '犬', provider: p });
  assert.equal(r.meaning, '');
  assert.equal(r.meaningSource, 'none');
});

// ══════════════════════════════════════════════════════════
// 3. 三种状态 + 缺释义仍可导出
// ══════════════════════════════════════════════════════════

test('T4 · 状态一：未配置', () => {
  const p = createNoopProvider('未配置日文释义文件');
  const r = p.lookup({ word: '猫' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'NOT_CONFIGURED');
  assert.match(r.message, /未配置/);

  const m = resolveMeaning({ word: '猫', provider: p });
  assert.equal(m.meaningSource, 'none');
  assert.equal(m.providerStatus, 'unconfigured');
});

test('T4 · 状态二：查询未命中（配置了但没这个词）', () => {
  const dir = tmp();
  const file = join(dir, 'meanings.json');
  writeFileSync(file, JSON.stringify({ entries: [{ word: '猫', meaning: '猫' }] }), 'utf8');
  const p = createFileProvider({ file });
  const r = p.lookup({ word: '犬' });
  assert.equal(r.ok, true, '未命中不是错误');
  assert.equal(r.found, false);

  const m = resolveMeaning({ word: '犬', provider: p });
  assert.equal(m.meaningSource, 'none');
  assert.equal(m.providerStatus, 'ok');
});

test('T4 · 状态三：加载失败（内容坏）与未配置（文件不存在）要分开', () => {
  // 文件不存在且**不是**显式配置 = 未配置：用户还没准备释义，属正常状态
  const p1 = createFileProvider({ file: join(tmp(), 'nope.json') });
  assert.equal(p1.status, 'unconfigured');
  const r1 = p1.lookup({ word: '猫' });
  assert.equal(r1.ok, false);
  assert.equal(r1.error, 'NOT_CONFIGURED');
  assert.match(r1.message, /未找到/);

  // 文件不存在但**是**用户显式配置的路径 = 加载失败（否则会掩盖拼写错误）
  const p2 = createFileProvider({ file: join(tmp(), '拼错的名字.json'), explicit: true });
  assert.equal(p2.status, 'failed');
  assert.match(p2.error, /配置的释义文件不存在/);

  // 文件存在但解析不了 = 加载失败
  const dir = tmp();
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{ broken', 'utf8');
  const p3 = createFileProvider({ file: bad });
  assert.equal(p3.status, 'failed');
  assert.match(p3.error, /JSON/);

  const m = resolveMeaning({ word: '猫', provider: p3 });
  assert.equal(m.providerStatus, 'failed');
  assert.equal(m.meaningSource, 'none');
});

test('T4 · 提示按运行汇总，不逐词刷屏', () => {
  const items = [{ meaning: '' }, { meaning: '' }, { meaning: '有' }];
  const w1 = meaningWarnings(items, { status: 'unconfigured', error: '' });
  assert.equal(w1.length, 1, '未配置只出一条汇总');
  assert.match(w1[0].message, /2\/3/);

  const w2 = meaningWarnings(items, { status: 'failed', error: '文件不存在' });
  assert.equal(w2.length, 1);
  assert.match(w2[0].message, /加载失败/);

  const w3 = meaningWarnings(items, { status: 'ok', error: '' });
  assert.equal(w3.length, 1);
  assert.match(w3[0].message, /2\/3 个词条没有释义/);

  // 全都有释义时不打扰
  assert.equal(meaningWarnings([{ meaning: '有' }], { status: 'ok', error: '' }).length, 0);
});

// ══════════════════════════════════════════════════════════
// 4. 字段往返：卡片 → 备份恢复 → 导出导入 → 重渲染
// ══════════════════════════════════════════════════════════

const JA_DIGEST = {
  language: 'ja',
  items: [
    {
      word: '日本',
      display: '日本',
      pos: 'prop.',
      count: 3,
      entryKey: 'ja|日本|ニホン|prop.',
      reading: 'ニホン',
      readingHiragana: 'にほん',
      posDetail: '固有名詞',
      unknown: false,
      lemmaSource: 'dict',
      language: 'ja',
      meaning: '日本',
      meaningLanguage: 'zh',
      meaningSource: 'provider',
      usages: [],
    },
    {
      word: 'Vtuber',
      display: 'Vtuber',
      pos: 'prop.',
      count: 1,
      entryKey: 'ja|Vtuber|?|prop.',
      reading: '',
      readingHiragana: '',
      posDetail: '*',
      unknown: true,
      lemmaSource: 'surface',
      language: 'ja',
      meaning: '',
      meaningLanguage: '',
      meaningSource: 'none',
      usages: [],
    },
  ],
};

test('T4 · 卡片保留 entryKey / 读音 / 语言 / 释义来源', () => {
  const store = new WordlistStore(tmp());
  const cards = store.cardsFromDigest(JA_DIGEST);
  assert.equal(cards.length, 2);

  const a = cards[0];
  assert.equal(a.language, 'ja');
  assert.equal(a.entryKey, 'ja|日本|ニホン|prop.');
  assert.equal(a.reading, 'ニホン');
  assert.equal(a.readingHiragana, 'にほん');
  assert.equal(a.posDetail, '固有名詞');
  assert.equal(a.senses[0].meaningLanguage, 'zh');
  assert.equal(a.senses[0].meaningSource, 'provider');

  const b = cards[1];
  assert.equal(b.unknown, true);
  assert.equal(b.lemmaSource, 'surface');
  assert.equal(b.reading, '');
});

test('T4 · 备份 → 恢复：卡片字段与掌握状态完整保留', () => {
  const dir = tmp();
  const store = new WordlistStore(dir);
  const created = store.create({ name: '日文测试', cards: store.cardsFromDigest(JA_DIGEST) });
  // 标两个为已掌握
  store.writeKnown(created.id, ['ja|日本|ニホン|prop.']);

  const backupFile = join(dir, 'backup.json');
  const b = store.backup(created.id, backupFile);
  assert.equal(b.count, 2);
  assert.equal(b.known, 1, '备份要带 known');

  const raw = JSON.parse(readFileSync(backupFile, 'utf8'));
  assert.deepEqual(raw.known, ['ja|日本|ニホン|prop.']);
  assert.equal(raw.cards[0].entryKey, 'ja|日本|ニホン|prop.');

  const restored = store.restoreBackup(backupFile, { name: '恢复的词表' });
  assert.equal(restored.cards, 2);
  assert.equal(restored.known, 1);

  const { cards } = store.cards(restored.id);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].entryKey, 'ja|日本|ニホン|prop.');
  assert.equal(cards[0].reading, 'ニホン');
  assert.equal(cards[0].language, 'ja');
  assert.equal(cards[0].senses[0].meaningSource, 'provider');
  assert.equal(cards[1].lemmaSource, 'surface');

  assert.deepEqual(store.known(restored.id), ['ja|日本|ニホン|prop.'], '掌握状态要恢复');
});

test('T4 · 导出 → 再导入：entryKey 与读音不丢', () => {
  const store = new WordlistStore(tmp());
  const created = store.create({ name: '导出测试', cards: store.cardsFromDigest(JA_DIGEST) });
  const { text } = store.exportText(created.id);

  // 导出文本里要能看见元信息行；文本层会把 `|` 再转义一层（`\|`）
  assert.ok(
    text.includes('#ja ja\\|日本\\|ニホン\\|prop.'),
    `导出文本里应保留 entryKey（实际：${text.split('\n').find((l) => l.startsWith('#ja')) ?? '没有 #ja 行'}）`,
  );
  assert.match(text, /读音：ニホン/);

  // 再导入
  const reimported = store.importFile({ text, name: '重新导入' });
  const { cards } = store.cards(reimported.id);
  const jp = cards.find((c) => c.word === '日本');
  assert.ok(jp, `重新导入后应能找到日本：${cards.map((c) => c.word).join(',')}`);
  assert.equal(jp.entryKey, 'ja|日本|ニホン|prop.', 'entryKey 必须保留');
  assert.equal(jp.reading, 'ニホン', '读音必须保留');
  assert.equal(jp.language, 'ja');
});

test('T4 · 释义来源用词表时，词表按 entryKey 提供释义（同形异读不串项）', () => {
  const store = new WordlistStore(tmp());
  const cards = [
    {
      word: '日本', display: '日本', kind: 'word', language: 'ja', entryKey: 'ja|日本|ニホン|prop.',
      reading: 'ニホン', pos: 'prop.', senses: [{ pos: 'prop.', meaning: '日本（にほん）', meaningLanguage: 'zh' }], scene: [], tags: [],
    },
    {
      word: '日本', display: '日本', kind: 'word', language: 'ja', entryKey: 'ja|日本|ニッポン|prop.',
      reading: 'ニッポン', pos: 'prop.', senses: [{ pos: 'prop.', meaning: '日本（にっぽん）', meaningLanguage: 'zh' }], scene: [], tags: [],
    },
  ];
  const created = store.create({ name: '异读表', cards });
  const map = store.meaningsByEntryKey(created.id);

  assert.equal(map.get('ja|日本|ニホン|prop.').meaning, '日本（にほん）');
  assert.equal(map.get('ja|日本|ニッポン|prop.').meaning, '日本（にっぽん）');
  // 裸词形有歧义 → 不给兜底
  assert.equal(map.get('日本'), undefined, '同形异读时不能用裸词形兜底');
});

test('T4 · cardsToText 对英文卡片保持原格式（不引入 #ja 行）', () => {
  const cards = [{
    word: 'doctor', display: 'doctor', kind: 'word', language: 'en',
    senses: [{ pos: 'n.', meaning: '医生' }], scene: [], tags: [],
  }];
  const text = cardsToText(cards);
  assert.ok(!text.includes('#ja'), '英文卡片不该有日文元信息行');
  assert.match(text, /^doctor\r\nn\.\r\n医生/);
});
