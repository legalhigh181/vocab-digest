import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cardsHash, cardsToText, dedupeCards, normalizeNewlines, parseWordListText, primarySense,
} from '../src/wordlists/import.js';
import { WordlistStore, slugify } from '../src/wordlists/store.js';

// ── 导入器 ────────────────────────────────────────────────

test('导入：单 \\r 换行（老 Mac 格式）也要正确切行', () => {
  const text = 'consolidate\rv.\r使巩固\rdeceive\rv.\r欺骗\r';
  const { cards } = parseWordListText(text);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].word, 'consolidate');
  assert.deepEqual(cards[0].senses, [{ pos: 'v.', meaning: '使巩固' }]);
  assert.equal(normalizeNewlines('a\r\nb\rc\nd'), 'a\nb\nc\nd');
});

test('导入：一个词条多组「词性 → 释义」', () => {
  const text = 'surrender\rv.\r投降\rn.\r投降，自首\r';
  const { cards } = parseWordListText(text);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].senses.length, 2);
  assert.equal(cards[0].senses[1].pos, 'n.');
  assert.equal(primarySense(cards[0]).meaning, '投降；投降，自首');
});

test('导入：双空格一行两词要拆开，单空格是短语', () => {
  const { cards } = parseWordListText('deception   deceit\rn.\r欺骗\rjet lag\r时差反应\r');
  const words = cards.map((c) => c.word);
  assert.ok(words.includes('deception'));
  assert.ok(words.includes('deceit'));
  assert.ok(words.includes('jet lag'), '单空格分隔的整行是短语');
  assert.equal(cards.find((c) => c.word === 'jet lag').kind, 'phrase');
});

test('导入：短语表里没有词性行、含占位符、双空格折叠、连字符、大小写归一', () => {
  const text = [
    'stumble upon', '偶然发现',
    'be up to  something', '正在做某事',
    'red-handed', 'adj.', '正在作案的',
    'make a pass at sb', '试图接近某人',
    'Way To Go', '加把劲',
  ].join('\r\n');
  const { cards } = parseWordListText(text);
  const byWord = new Map(cards.map((c) => [c.word, c]));
  assert.equal(byWord.get('stumble upon').kind, 'phrase');
  assert.equal(byWord.get('be up to something').senses[0].meaning, '正在做某事');
  assert.equal(byWord.get('red-handed').senses[0].pos, 'adj.');
  assert.equal(byWord.get('make a pass at sb').kind, 'phrase');
  assert.equal(byWord.get('way to go').senses[0].meaning, '加把劲');
});

test('导入：重复词条合并去重，释义取并集不重复', () => {
  const { cards } = parseWordListText('vicious\radj.\r恶毒的\rvicious\radj.\r恶毒的\rvicious\radj.\r凶狠的\r');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].senses.length, 2);
  const again = dedupeCards([...cards, ...cards]);
  assert.equal(again.length, 1);
});

test('导入：卡片指纹稳定，内容变了才变', () => {
  const a = parseWordListText('go\rv.\r去\r').cards;
  const b = parseWordListText('go\rv.\r去\r').cards;
  const c = parseWordListText('go\rv.\r走\r').cards;
  assert.equal(cardsHash(a), cardsHash(b));
  assert.notEqual(cardsHash(a), cardsHash(c));
});

test('导入：导出文本能被重新导入（往返一致）', () => {
  const { cards } = parseWordListText('surrender\rv.\r投降\rn.\r投降，自首\rjet lag\r时差反应\r');
  const back = parseWordListText(cardsToText(cards)).cards;
  assert.equal(back.length, cards.length);
  assert.deepEqual(back.map((c) => c.word).sort(), cards.map((c) => c.word).sort());
});

// ── 词表仓储 ──────────────────────────────────────────────

function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), 'vd-wl-'));
  return { dir, store: new WordlistStore(dir) };
}

test('词表：新建 / 列表 / 重命名 / 切换 / 删除进回收站', () => {
  const { dir, store } = tmpStore();
  const a = store.create({ name: 'Day11 看病' });
  assert.equal(a.count, 0);
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].active, true, '第一张表自动激活');

  store.rename(a.id, 'Day11 Doctor');
  assert.equal(store.list()[0].name, 'Day11 Doctor');
  assert.equal(store.list()[0].id, a.id, '重命名不改 id');

  const b = store.create({ name: 'Another' });
  store.setActive(b.id);
  assert.equal(store.list().find((l) => l.active).id, b.id);

  store.remove(b.id);
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].id, a.id, '删掉激活表后回落到剩下的第一张');
  assert.ok(existsSync(join(dir, 'wordlists', '.trash')), '删除先进回收站');
});

test('词表：同名重复时 id 自动加后缀，目录名合法', () => {
  const { store } = tmpStore();
  const a = store.create({ name: '词汇' });
  const b = store.create({ name: '词汇' });
  assert.notEqual(a.id, b.id);
  assert.equal(slugify('Day 11 / 看病'), 'Day-11-看病');
});

test('词表：从 digest 结果一键建表，卡片带词性释义与用法', () => {
  const { store } = tmpStore();
  const digest = {
    items: [
      { word: 'feel', display: 'feel', pos: 'v.', count: 12, meaning: '感觉', usages: [{ text: 'I feel well', t: 3 }] },
      { word: 'runny nose', display: 'runny nose', pos: 'phr.', count: 2, meaning: '流鼻涕', usages: [] },
    ],
  };
  const cards = store.cardsFromDigest(digest);
  assert.equal(cards.length, 2);
  assert.equal(cards[1].kind, 'phrase');
  const created = store.create({ name: '来自视频', cards });
  assert.equal(created.count, 2);

  const patch = store.lexiconPatch(created.id);
  assert.equal(patch.pos.feel, 'v.');
  assert.equal(patch.decisions.feel.meaning, '感觉');
  assert.ok(patch.words.has('runny nose'));
});

test('词表：导入文件 → 导出文本；加卡片去重', () => {
  const { store } = tmpStore();
  const imported = store.importFile({ text: 'go\rv.\r去\rstop\rv.\r停\r', name: '小表' });
  assert.equal(imported.count, 2);
  assert.equal(imported.name, '小表');

  const res = store.addCards(imported.id, parseWordListText('go\rv.\r去\rrun\rv.\r跑\r').cards);
  assert.equal(res.added, 1, 'go 已存在不重复加');
  assert.equal(res.total, 3);

  const { text } = store.exportText(imported.id);
  assert.ok(text.includes('run'));
});

test('词表：cards.json 损坏时不抛栈，带 error 返回', () => {
  const { store } = tmpStore();
  const a = store.create({ name: 'bad' });
  writeFileSync(join(store.dirOf(a.id), 'cards.json'), '{坏掉的 json', 'utf8');
  const res = store.cards(a.id);
  assert.equal(res.cards.length, 0);
  assert.ok(res.error);
});

test('词表：备份文件可以被读回（json 结构完整）', () => {
  const { store } = tmpStore();
  const a = store.create({ name: '备份测试', cards: parseWordListText('go\rv.\r去\r').cards });
  const out = join(store.dataDir, 'bak.json');
  const { count } = store.backup(a.id, out);
  assert.equal(count, 1);
  const payload = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(payload.cards.length, 1);
  assert.equal(payload.meta.id, a.id);
});
