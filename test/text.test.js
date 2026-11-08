import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanFragmentText, splitSentences, squashRepeats } from '../src/clean.js';
import { tokenize, splitContraction, splitCompound } from '../src/tokenize.js';
import { createLemmatizer } from '../src/lexicon/lemmatize.js';
import { fmtTime, toHalfWidth, decodeEntities, stableStringify } from '../src/util.js';

test('清洗：去 URL / QQ 群号 / @ / 话题 / HTML 标签，保留英文', () => {
  const cases = [
    ['看 https://b23.tv/abc 这个', '看 这个'],
    ['加QQ群：123456789 一起', '加 一起'],
    ['@某人 hello', 'hello'],
    ['#干货# neural net', 'neural net'],
    ['<b>bold</b> text', 'bold text'],
  ];
  for (const [input, want] of cases) {
    const r = cleanFragmentText(input);
    assert.equal(r.clean, want, `输入 ${input}`);
  }
});

test('清洗：全角转半角、压缩重复字符、CJK 与拉丁之间补空格', () => {
  assert.equal(cleanFragmentText('ＨＥＬＬＯ').clean, 'HELLO');
  assert.equal(squashRepeats('sooooo good!!!!!!'), 'soo good!!');
  assert.equal(cleanFragmentText('好good').clean, '好 good');
});

test('清洗：没有拉丁字母的片段标记 dropped', () => {
  for (const s of ['233333 哈哈%100', '233333 哈哈哈哈', '一二三']) {
    const r = cleanFragmentText(s);
    assert.equal(r.dropped, true, s);
    assert.equal(r.reason, 'no-latin', s);
  }
});

test('清洗：括号 / 方括号 / 星号里的舞台提示整段丢弃', () => {
  // 字幕里的 (gentle music) / [Music] / *laughs* 不是「说的话」，
  // 若不清掉，gentle music 会以 38 次登顶短语榜（见真实视频实测）
  for (const s of ['(gentle music)', '[Music]', '*laughs*', '[MUSIC PLAYING]', '(soft music)']) {
    const r = cleanFragmentText(s);
    assert.equal(r.dropped, true, `${s} 应被判定为舞台提示`);
    assert.equal(r.reason, 'stage-direction');
  }
  // 含真实台词的括号只摘掉括号部分，正文保留
  assert.equal(cleanFragmentText('Put on (gentle music) please').clean, 'Put on please');
});

test('形态还原：复数补 e / z 结尾 / 词典词不误伤', () => {
  const dict = new Set(['hurt', 'meal', 'use', 'change', 'improve', 'behave', 'watch', 'glass']);
  const lemma = createLemmatizer({ dictionary: dict });
  assert.equal(lemma('hurts'), 'hurt');
  assert.equal(lemma('meals'), 'meal');
  assert.equal(lemma('improves'), 'improve'); // 不能走 -ves → -f
  assert.equal(lemma('behaves'), 'behave');
  assert.equal(lemma('watches'), 'watch');
  assert.equal(lemma('glasses'), 'glass');
  // 词典里没有原形时，裁过头会造出比原文更怪的词（nurses→nurs）。
  // 补 e 的版本要么来自词典里的原形（见上一条用例），要么靠用户在 data/known.txt 里补
  assert.equal(lemma('nurses'), 'nurs');
});

test('切句：中英文标点都切', () => {
  assert.deepEqual(splitSentences('i like it. you too! 真的吗？ok'), ['i like it', 'you too', '真的吗', 'ok']);
});

test('切词：过滤短词、剥首尾撇号、标 isShout', () => {
  const toks = tokenize("it's a very 'good' day in NASA", { minLen: 3 });
  const words = toks.map((t) => t.lower);
  assert.ok(words.includes('very'));
  assert.ok(words.includes('good'));
  assert.ok(words.includes('day'));
  assert.ok(!words.includes('a'));
  const nasa = toks.find((t) => t.lower === 'nasa');
  assert.equal(nasa.isShout, true);
});

test('缩略语与复合词', () => {
  assert.deepEqual(splitContraction("don't"), { stem: 'don', suffix: 't' });
  assert.equal(splitContraction('its'), null);
  assert.deepEqual(splitCompound('well-known'), ['well', 'known']);
  assert.deepEqual(splitCompound('keyBoard'), ['key', 'Board']);
});

test('工具：全角/实体/时间/稳定序列化', () => {
  assert.equal(toHalfWidth('ＡＢＣ１２３　'), 'ABC123 ');
  assert.equal(decodeEntities('a &amp; b &#65; &unknown;'), 'a & b A &unknown;');
  assert.equal(fmtTime(5), '00:05');
  assert.equal(fmtTime(75), '01:15');
  assert.equal(fmtTime(3725), '1:02:05');
  assert.equal(stableStringify({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
});
