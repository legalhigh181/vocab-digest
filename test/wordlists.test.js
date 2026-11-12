import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cardsHash, cardsToText, dedupeCards, normalizeNewlines, parseWordListText, primarySense,
} from '../src/wordlists/import.js';
import {
  WordlistStore, normalizeCount, readKnownFile, slugify,
} from '../src/wordlists/store.js';

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

// ── T4：单词表存储的四项独立修复 ──────────────────────────
// 这一组只覆盖「存储层」本身。日文卡片、读音和导出要等 T3 接入后才验收，
// 所以整体 T4 不能因为这一组通过就算完成。

test('T4 · count 归一：任何脏值都收敛成非负整数', () => {
  assert.equal(normalizeCount(0), 0);
  assert.equal(normalizeCount(12), 12);
  assert.equal(normalizeCount('7'), 7);
  assert.equal(normalizeCount(' 8 '), 8);
  // 括号内容就是历史 bug：调用点传了对象
  assert.equal(normalizeCount({ count: 3 }), 0, '对象不能变成 [object Object] 落盘');
  assert.equal(normalizeCount(-5), 0, '负数收敛到 0');
  assert.equal(normalizeCount(3.7), 3, '小数截断');
  assert.equal(normalizeCount(NaN), 0);
  assert.equal(normalizeCount(Infinity), 0);
  assert.equal(normalizeCount(null), 0);
  assert.equal(normalizeCount(undefined), 0);
});

test('T4 · touch(id, count)：索引与 meta.json 落盘的都是数字', () => {
  const { store } = tmpStore();
  const a = store.create({ name: 'touch 表' });

  assert.equal(store.touch(a.id, 5), 5, '返回归一后的值');

  const entry = store.list().find((l) => l.id === a.id);
  assert.equal(entry.count, 5);
  assert.equal(typeof entry.count, 'number');
  assert.equal(typeof store.meta(a.id).count, 'number');
  assert.equal(store.meta(a.id).count, 5);

  // 脏值也必须落成数字
  store.touch(a.id, { count: 9 });
  assert.equal(store.list().find((l) => l.id === a.id).count, 0);
  assert.equal(store.meta(a.id).count, 0);
  assert.equal(typeof store.meta(a.id).count, 'number');

  // 磁盘上的 JSON 里不能出现字符串或对象形式的 count
  const onDisk = JSON.parse(readFileSync(store.indexFile, 'utf8'));
  assert.equal(typeof onDisk.lists.find((l) => l.id === a.id).count, 'number');
});

test('T4 · 空 known.txt：写真正空文本，不是 JSON 字符串', () => {
  const { store } = tmpStore();
  const a = store.create({ name: '空表' });
  const file = store.knownFileOf(a.id);
  assert.ok(existsSync(file), 'known.txt 应该被建出来');
  const raw = readFileSync(file, 'utf8');
  assert.equal(raw, '', '必须是零字节文本');
  assert.notEqual(raw, '""', '不能写成 JSON 字符串');
  assert.deepEqual(readKnownFile(file), [], '读回来是空数组');
});

test('T4 · known 读写往返 + 清空回真正空文本', () => {
  const { store } = tmpStore();
  const a = store.create({ name: 'known 表' });
  assert.equal(store.writeKnown(a.id, ['b', 'a', 'c']), 3);
  assert.deepEqual(store.known(a.id), ['b', 'a', 'c']);
  assert.equal(store.writeKnown(a.id, []), 0);
  assert.equal(readFileSync(store.knownFileOf(a.id), 'utf8'), '');
  assert.deepEqual(store.known(a.id), []);
});

test('T4 · 旧数据兼容：历史遗留的 "" / JSON 数组 known 都能正确读', () => {
  const { store } = tmpStore();
  const a = store.create({ name: '旧表' });
  const file = store.knownFileOf(a.id);

  writeFileSync(file, '""', 'utf8');
  assert.deepEqual(readKnownFile(file), [], '旧版 create 写出的 "" 当作空表');

  writeFileSync(file, '["go","stop"]', 'utf8');
  assert.deepEqual(readKnownFile(file), ['go', 'stop'], 'JSON 数组也能读');

  writeFileSync(file, 'go\r\nstop\r\n', 'utf8');
  assert.deepEqual(readKnownFile(file), ['go', 'stop'], 'CRLF 正常');

  writeFileSync(file, 'go\rstop\r', 'utf8');
  assert.deepEqual(readKnownFile(file), ['go', 'stop'], '老 Mac 单 \\r 也能读');

  // 读旧数据不应该反向污染：已知文件还在原地没被改写
  assert.ok(existsSync(file));
});

test('T4 · 导入默认不标掌握；只有 markKnown:true 才写 known', () => {
  const { store } = tmpStore();
  const text = 'go\rv.\r去\rstop\rv.\r停\r';

  const plain = store.importFile({ text, name: '普通导入' });
  assert.equal(plain.count, 2);
  assert.equal(plain.markKnown, false);
  assert.equal(readFileSync(store.knownFileOf(plain.id), 'utf8'), '', '默认不写任何掌握词');
  assert.deepEqual(store.known(plain.id), []);

  const marked = store.importFile({ text, name: '已掌握导入', markKnown: true });
  assert.equal(marked.markKnown, true);
  assert.deepEqual(store.known(marked.id), ['go', 'stop']);
});

test('T4 · 导入不标掌握后，历史掌握状态保持不变', () => {
  const { store } = tmpStore();
  // 先有一张「已经知道这些词」的表
  const known = store.importFile({ text: 'go\rv.\r去\r', name: '已知词', markKnown: true });
  assert.deepEqual(store.known(known.id), ['go']);

  // 再导入一张不标掌握的表，不能动到前一张
  const fresh = store.importFile({ text: 'stop\rv.\r停\r', name: '新表' });
  assert.deepEqual(store.known(fresh.id), []);
  assert.deepEqual(store.known(known.id), ['go'], '历史掌握状态不受影响');
  assert.equal(readFileSync(store.knownFileOf(known.id), 'utf8'), 'go\n');
});

test('T4 · 回收站失败：保留词表目录、索引与 activeId，并明确报错', () => {
  const { dir, store } = tmpStore();
  const a = store.create({ name: '会被删的表', cards: parseWordListText('go\rv.\r去\r').cards });
  assert.equal(store.index().activeId, a.id);

  // 用一个「已存在同名目录」的花招让 rename 必然失败：
  // 回收站目录位置放一个同名文件，Windows 上 rename 会报 EEXIST/EPERM
  const trashDir = join(dir, 'blocked-trash');
  mkdirSync(trashDir, { recursive: true });
  writeFileSync(join(trashDir, 'not-a-dir'), 'x', 'utf8');
  // 更直接：把 trashDir 指到一个「文件」上，mkdir 必然失败
  writeFileSync(join(dir, 'trash-as-file'), 'x', 'utf8');

  let err = null;
  try {
    store.remove(a.id, { trashDir: join(dir, 'trash-as-file', 'inner') });
  } catch (e) { err = e; }

  assert.ok(err, '回收站失败必须抛错');
  assert.equal(err.code, 'WORDLIST_TRASH_FAILED');
  assert.equal(err.listId, a.id);
  assert.match(err.message, /原样保留/);

  // 数据必须原封不动
  assert.ok(existsSync(store.dirOf(a.id)), '词表目录还在');
  assert.ok(existsSync(store.knownFileOf(a.id)), 'known.txt 还在');
  assert.equal(store.cards(a.id).cards.length, 1, '卡片还在');
  assert.equal(store.index().activeId, a.id, 'activeId 没变');
  assert.equal(store.list().length, 1, '索引里那条还在');
});

test('T4 · 回收站成功的正常路径：目录挪进 .trash，索引同步移除', () => {
  const { dir, store } = tmpStore();
  const a = store.create({ name: '正常删除' });
  const b = store.create({ name: '留着的' });
  store.setActive(b.id);

  const r = store.remove(a.id);
  assert.equal(r.removed, a.id);
  assert.equal(r.activeId, b.id, '没删激活表就不动 activeId');
  assert.ok(r.trash, '返回回收站路径');
  assert.ok(existsSync(r.trash), '真的挪进了回收站');
  assert.ok(!existsSync(store.dirOf(a.id)), '原目录不在了');
  assert.equal(store.list().length, 1);

  const trashEntries = readdirSync(join(dir, 'wordlists', '.trash'));
  assert.ok(trashEntries.some((n) => n.startsWith(a.id)), '回收站里能按 id 找到');
});

test('T4 · 回收站失败后重试成功：索引与磁盘仍然一致', () => {
  const { dir, store } = tmpStore();
  const a = store.create({ name: '重试表' });

  // 回收站目录的位置被一个同名「文件」占住：mkdir 必然失败 → rename 也走不通
  writeFileSync(join(dir, 'blocked-trash'), 'x', 'utf8');
  assert.throws(
    () => store.remove(a.id, { trashDir: join(dir, 'blocked-trash') }),
    (e) => e.code === 'WORDLIST_TRASH_FAILED',
  );
  assert.equal(store.list().length, 1, '失败后索引未被改动');
  assert.ok(existsSync(store.dirOf(a.id)), '失败后目录还在');

  // 换回默认回收站就能删掉
  const r = store.remove(a.id);
  assert.equal(r.removed, a.id);
  assert.equal(store.list().length, 0);
});
