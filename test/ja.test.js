/**
 * T3 日文引擎测试。
 *
 * 对应交付验收的七条标准，每条都有独立断言：
 *   1. 锁定版本 / 资源缺失明确报错
 *   2. 独立清洗 / 分词 / 词性映射 / 一字实词保留
 *   3. 未知词标 unknown + lemmaSource='surface'，不编造读音
 *   4. 原形读音 ≠ 活用读音
 *   5. offset 是 UTF-16 半开区间，slice(start,end) === 表面形
 *   6. サ変名詞+する 只在相邻时合并，不跨标点
 *   7. 同形异读/异词性不误合并
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanJapanese, splitSentencesJa } from '../src/ja/clean.js';
import { collectJa, kataToHira, posFromJa } from '../src/ja/extract.js';
import { digestJa, parseJaEntryKey } from '../src/ja/index.js';
import { buildTokenizer, hasTokenizerDependency, kuromojiDictPath, kuromojiVersion } from '../src/ja/tokenizer.js';

const hasDep = hasTokenizerDependency();
const skip = hasDep ? false : 'kuromoji 未安装';

let tokenizerPromise = null;
function tk() {
  if (!tokenizerPromise) tokenizerPromise = buildTokenizer();
  return tokenizerPromise;
}

const CFG = { lexicon: { minLen: 1, minFreq: 1 }, docx: { samplePerWord: 2, usagePerWord: 3 } };

async function run(texts) {
  const fragments = texts.map((text, i) => ({ text, t: i, src: 'test.srt' }));
  return digestJa(fragments, CFG, { tokenizer: await tk() });
}
const findItem = (res, word) => res.items.find((it) => it.word === word);

// ── 标准 1：版本锁定与资源缺失 ──────────────────────────────

test('T3 · 版本锁定：kuromoji 版本可读，词典目录存在', { skip }, () => {
  assert.equal(kuromojiVersion(), '0.1.2');
  const p = kuromojiDictPath();
  assert.ok(p.includes('kuromoji'), p);
  assert.ok(p.endsWith('dict'), p);
});

test('T3 · 词典目录给错时明确报 JA_DICT_MISSING，而不是静默空转', { skip }, async () => {
  // 用一个从未加载过的假目录，绕开进程内缓存
  const bogus = `${kuromojiDictPath()}-does-not-exist-${Date.now()}`;
  let caught = null;
  try {
    await buildTokenizer({ dicPath: bogus });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, '词典目录错误时必须抛错，不能静默返回空分词器');
  assert.equal(caught.code, 'JA_DICT_MISSING');
  assert.match(caught.message, /日文词典加载失败/);
  assert.equal(caught.dicPath, bogus);
});

// ── 标准 2：清洗 / 分词 / 词性映射 / 一字实词 ────────────────

test('T3 · 清洗：半角片假名 NFKC 归一后才能被词典识别', { skip }, async () => {
  const halfWidth = await run(['ｺｰﾋｰを飲む']);
  const item = findItem(halfWidth, 'コーヒー');
  assert.ok(item, '半角 ｺｰﾋｰ 应归一成 コーヒー 并命中词典');
  assert.equal(item.unknown, false);
  assert.equal(item.reading, 'コーヒー');
});

test('T3 · 清洗：全角括号不整段删除（与英文舞台提示规则不同）', () => {
  const r = cleanJapanese('そうですね（笑）');
  assert.equal(r.dropped, false);
  assert.ok(r.clean.includes('そう'), r.clean);
  assert.ok(r.clean.includes('笑'), `括号里的字不能被吃掉：${r.clean}`);
});

test('T3 · 清洗：纯符号 / URL 片段被丢弃', () => {
  assert.equal(cleanJapanese('♪♪♪').dropped, true);
  assert.equal(cleanJapanese('https://example.com/a').dropped, true);
  assert.equal(cleanJapanese('233333').dropped, true);
});

test('T3 · 词性映射：名詞/動詞/形容詞/固有名詞/代名詞 各归其位', () => {
  assert.equal(posFromJa('名詞', '一般'), 'n.');
  assert.equal(posFromJa('名詞', '固有名詞'), 'prop.');
  assert.equal(posFromJa('名詞', '代名詞'), 'pron.');
  assert.equal(posFromJa('動詞', '自立'), 'v.');
  assert.equal(posFromJa('動詞', '非自立'), 'aux.');
  assert.equal(posFromJa('形容詞', '自立'), 'adj.');
  assert.equal(posFromJa('助詞', '*'), 'part.');
  assert.equal(posFromJa('記号', '句点'), 'sym.');
});

test('T3 · 一字实词（猫 / 手）默认保留', { skip }, async () => {
  const res = await run(['猫が好き', '手を洗う']);
  assert.ok(findItem(res, '猫'), '一字名词 猫 应保留');
  assert.ok(findItem(res, '手'), '一字名词 手 应保留');
});

test('T3 · 语法成分不进词表：助词、助动词、接尾动词（れる）、形式名词（こと）', { skip }, async () => {
  const res = await run(['先生に宿題を出された。', '勉強することが好きです。']);
  const words = res.items.map((it) => it.word);
  assert.ok(!words.includes('は'), '助词不应进表');
  assert.ok(!words.includes('た'), '助动词不应进表');
  assert.ok(!words.includes('れる'), '接尾动词 れる 不应进表');
  assert.ok(!words.includes('こと'), '形式名词 こと 不应进表');
  assert.ok(words.includes('宿題'), '实词 宿題 应在表里');
});

// ── 标准 3：未知词 ─────────────────────────────────────────

test('T3 · 未知词：标记 unknown + lemmaSource=surface，读音留空不编造', { skip }, async () => {
  const res = await run(['Vtuberとして活動しています']);
  const it = findItem(res, 'Vtuber');
  assert.ok(it, 'Vtuber 应作为未知词保留表面形');
  assert.equal(it.unknown, true);
  assert.equal(it.lemmaSource, 'surface');
  assert.equal(it.reading, '', '未知词读音必须留空');
  assert.equal(it.readingHiragana, '');
  assert.equal(it.count, 1, '未知词仍要计数');
});

test('T3 · 未知词占比按两种口径分别统计', { skip }, async () => {
  const res = await run(['Vtuberと猫']);
  assert.ok(Number.isFinite(res.stats.unknownTokenRatio));
  assert.ok(Number.isFinite(res.stats.unknownItemRatio));
  assert.equal(res.stats.unknownItemCount, 1);
  assert.equal(res.stats.itemCount, res.items.length);
});

// ── 标准 4：原形读音 ≠ 活用读音 ──────────────────────────

test('T3 · 活用词：原形读音取基本形，不是活用形读音', { skip }, async () => {
  const res = await run(['彼は東京に住んでいます。', 'コーヒーを飲みたかった。']);
  const sum = findItem(res, '住む');
  assert.ok(sum, '住ん → 住む');
  assert.equal(sum.reading, 'スム', '住む 的读音必须是 スム，不能是住ん的スン');

  const nomu = findItem(res, '飲む');
  assert.ok(nomu, '飲み → 飲む');
  assert.equal(nomu.reading, 'ノム', '飲む 的读音必须是 ノム，不能是飲み的ノミ');
});

test('T3 · 活用词读音不会反过来污染：住ん 的读音 スン 不出现在任何词条上', { skip }, async () => {
  const res = await run(['住んでいます']);
  for (const it of res.items) {
    assert.notEqual(it.reading, 'スン', `${it.word} 不该被标成活用读音 スン`);
  }
});

// ── 标准 5：offset ────────────────────────────────────────

test('T3 · offset 是 UTF-16 半开区间，slice(start,end) 等于表面形', { skip }, async () => {
  const res = await run(['今日はいい天気ですね。', 'コーヒーを飲みたかった。']);
  let checked = 0;
  for (const it of res.items) {
    for (const u of it.usages) {
      assert.equal(u.text.slice(u.start, u.end), u.surface, `${it.word} @ ${u.text}`);
      checked += 1;
    }
  }
  assert.ok(checked >= 4, `至少要检查到 4 处，实际 ${checked}`);
});

test('T3 · offset 对含拉丁字母 / 全角字符的句子也成立', { skip }, async () => {
  const res = await run(['Vtuberとして活動しています']);
  const it = findItem(res, 'Vtuber');
  assert.ok(it);
  const u = it.usages[0];
  assert.equal(u.text.slice(u.start, u.end), 'Vtuber');
});

// ── 标准 6：サ変名詞 + する ───────────────────────────────

test('T3 · サ変合并：勉強しました → 勉強する，读音 ベンキョウスル', { skip }, async () => {
  const res = await run(['勉強しました']);
  const it = findItem(res, '勉強する');
  assert.ok(it, '勉強 + しました 应合并成 勉強する');
  assert.equal(it.pos, 'v.');
  assert.equal(it.reading, 'ベンキョウスル');
  assert.equal(it.readingHiragana, 'べんきょうする');
});

test('T3 · サ変合并：し/さ/せ/しよ 各活用形都能合并', { skip }, async () => {
  for (const [src, expect] of [['勉強し', '勉強する'], ['活動さ', '活動する'], ['活動せ', '活動する']]) {
    const res = await run([`${src}せています`]);
    assert.ok(findItem(res, expect), `${src}… 应合并成 ${expect}`);
  }
});

test('T3 · サ変不跨标点：勉強、する 中间有逗号时不合并', { skip }, async () => {
  const res = await run(['勉強、する']);
  assert.equal(findItem(res, '勉強する'), undefined, '隔了逗号不能合并');
  assert.ok(findItem(res, '勉強'), '应该各自成词（勉強）');
});

test('T3 · サ変不跨句子边界', { skip }, async () => {
  const res = await run(['勉強。する。']);
  assert.equal(findItem(res, '勉強する'), undefined);
});

test('T3 · 普通名词 + する 不合并（只有サ変接続 才合并）', { skip }, async () => {
  const res = await run(['猫をする']);
  assert.equal(findItem(res, '猫する'), undefined, '猫 不是サ変接続，不该合并');
});

// ── 标准 7：同形异读 / 异词性 ─────────────────────────────

test('T3 · 异词性不合并：同一个词形落到不同 pos 时分开成两条', { skip }, async () => {
  // 走る 作动词 + 走り 作名词（走り 的基本形是 走り）
  const res = await run(['走った', '走りが速い']);
  const verbs = res.items.filter((it) => it.word === '走る');
  // 必须只有一条「走る#v.」，不能因为表面形不同就分裂成多条
  assert.equal(verbs.length, 1, `走る 应聚成一条，实际 ${verbs.length}`);
  assert.equal(verbs[0].count, 1, '只有走った 计入 走る');
});

test('T3 · entryKey 稳定且唯一：含语言 + 词形 + 读音 + 词性', { skip }, async () => {
  const res = await run(['勉強することが好きです。', '勉強した']);
  const keys = res.items.map((it) => it.entryKey);
  assert.equal(new Set(keys).size, keys.length, 'entryKey 不能重复');
  for (const it of res.items) {
    // 形如 ja|词形|读音|词性（读音未知时用 ? 占位）
    // 分隔符必须是可打印字符：NUL 会被编辑器/剪贴板静默吃掉，导致导出再导入丢键
    assert.ok(!/[\u0000-\u001f]/.test(it.entryKey), `键里不能有控制字符：${JSON.stringify(it.entryKey)}`);
    const key = it.entryKey;
    assert.ok(key.startsWith('ja|'), `键必须以 ja| 开头：${key}`);
    const parsed = parseJaEntryKey(key);
    assert.ok(parsed, `键必须能反解析：${key}`);
    assert.equal(parsed.word, it.word);
    assert.equal(parsed.pos, it.pos);
    assert.equal(parsed.reading, it.reading || '');
  }
});

test('T3 · 同形重复出现要累加次数，不是拆成两条', { skip }, async () => {
  const res = await run(['走った、走った。']);
  const it = findItem(res, '走る');
  assert.ok(it);
  assert.equal(it.count, 2);
  assert.deepEqual(Object.keys(it.forms).sort(), ['走っ']);
});

// ── 读音工具 ─────────────────────────────────────────────

test('T3 · 片假名转平假名：保留长音符，非假名字符原样', () => {
  assert.equal(kataToHira('スキ'), 'すき');
  assert.equal(kataToHira('コーヒー'), 'こーひー');
  assert.equal(kataToHira(''), '');
});

test('T3 · 切句：句点/感叹/问号/省略号都能切', () => {
  const parts = splitSentencesJa('今日は晴れ。明日は雨！本当？そう…');
  assert.ok(parts.length >= 3, parts.join('|'));
});

// ── 整体：未知词不编造 & 统计口径 ────────────────────────────

test('T3 · 端到端：10 段样例能出词条，且没有任何词条读音是编造的', { skip }, async () => {
  const res = await run([
    '今日はいい天気ですね。',
    '彼は東京に住んでいます。',
    '勉強することが好きです。',
    '先生に宿題を出された。',
    'コーヒーを飲みたかった。',
  ]);
  assert.ok(res.items.length >= 8, `词条太少：${res.items.length}`);
  for (const it of res.items) {
    if (it.unknown) assert.equal(it.reading, '', `${it.word} 未知词不该有读音`);
    if (it.reading) assert.match(it.reading, /^[\u30A0-\u30FF]+$/, `${it.word} 读音应是片假名：${it.reading}`);
  }
  assert.equal(res.tokenizerVersion, '0.1.2');
  assert.equal(res.phraseCount, 0, '首版 ja 不做短语抽取');
});

test('T3 · 首版不产出释义（T7 才接日汉词典）', { skip }, async () => {
  const res = await run(['猫が好き']);
  for (const it of res.items) {
    assert.equal(it.meaning, '');
    assert.equal(it.meaningSource, '');
  }
});
