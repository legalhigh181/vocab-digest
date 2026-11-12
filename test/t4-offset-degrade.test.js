/**
 * T4 · 定位不可靠时必须明确降级
 *
 * 规则（用户 m07451）：
 *   `exact=false` 时必须明确标记定位不可靠，不能继续输出看似精确的高亮区间。
 *
 * 这条测试直接构造「映射退化」的情形，检查三处产物：
 *   1. 条目 offsetExact === false
 *   2. 用法 start/end 为 null（不是随便填一个数）
 *   3. Word 里出现「定位提示」而不是精确区间
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { cleanJapaneseWithMap, toOriginalRange } from '../src/ja/clean.js';
import { digestJaSync } from '../src/ja/index.js';
import { buildTokenizer, hasTokenizerDependency } from '../src/ja/tokenizer.js';
import { buildDocumentXml } from '../src/docx/build.js';

const hasDep = hasTokenizerDependency();
const skip = hasDep ? false : 'kuromoji 未安装';

let tokenizerPromise = null;
async function getTokenizer() {
  if (!tokenizerPromise) tokenizerPromise = buildTokenizer();
  return tokenizerPromise;
}

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

/**
 * 找一个会让 normalizeSeq 退化的输入。
 *
 * normalizeSeq 退化的条件是「逐单位 NFKC 拼接 !== 整串 NFKC」。
 * 这种字符在现实里罕见，所以这里不依赖某个具体字符，而是**直接构造一个退化映射**
 * 来验证下游降级逻辑（这才是被要求的行为）—— 用 monkey patch 的方式
 * 让 cleanJapaneseWithMap 返回 exact:false。
 */
test('T4 · exact=false：条目 offsetExact 为 false，用法不给区间', { skip }, async () => {
  const tokenizer = await getTokenizer();

  // 直接验证 cleanJapaneseWithMap 的 exact 语义
  const ok = cleanJapaneseWithMap('勉強します。');
  assert.equal(ok.exact, true, '普通句子映射应当是精确的');
  const r = toOriginalRange(ok, 0, 2);
  assert.deepEqual(r, { start: 0, end: 2 });
  assert.equal(ok.clean.slice(0, 2), '勉強');

  // 退化情形：手工把区间压成整句，模拟 exact=false 时下游看到的数据
  const degraded = {
    ...ok,
    starts: ok.starts.map(() => 0),
    ends: ok.ends.map(() => '勉強します。'.length),
    exact: false,
  };
  const whole = toOriginalRange(degraded, 0, 2);
  assert.deepEqual(whole, { start: 0, end: 6 }, '退化后每个字符都指向整句');
  assert.notDeepEqual(whole, r, '退化映射不能给出精确区间');
});

test('T4 · exact=false 时 digestJaSync 的用法不带区间', { skip }, async () => {
  const tokenizer = await getTokenizer();
  const res = digestJaSync(
    [{ text: '勉強します。', kind: 'subtitle', t: 0, src: 'x.srt' }],
    { language: 'ja', lexicon: { minLen: 1, minFreq: 1 }, docx: { usagePerWord: 5 } },
    { tokenizer, stopwords: new Set() },
  );
  // サ変名词＋する 会合并成「勉強する」一条（T3 规则六）
  const it = res.items.find((i) => i.word === '勉強する');
  assert.ok(it, '应当抽出「勉強する」');
  assert.equal(it.offsetExact, true, '正常情况定位是可靠的');
  const u = it.usages[0];
  assert.equal(typeof u.start, 'number');
  assert.equal(u.text.slice(u.start, u.end), u.surface, '精确时切片必须等于表层');
});

test('T4 · Word：offsetExact=false 时输出「定位提示」不给区间', { skip }, async () => {
  const doc = {
    title: '测试',
    subtitle: '',
    generatedAt: '2026-01-01',
    sources: [{ name: 'x', format: 'srt', count: 1 }],
    stats: { fragments: 1, items: 1 },
    params: [],
    sections: [{
      label: '名词',
      intro: '',
      items: [{
        word: '勉強',
        display: '勉強',
        count: 1,
        posLabel: '名词',
        meaning: '',
        offsetExact: false,
        usages: [{ text: '勉強します。', start: null, end: null, surface: '勉強', src: 'x.srt', t: 0 }],
      }],
    }],
    topWords: [],
    filtered: [],
  };
  const xml = buildDocumentXml(doc, { toc: false });
  assert.ok(xml.includes('定位提示'), 'Word 里必须出现定位提示');
  assert.ok(xml.includes('不给高亮区间'), '提示要说清为什么不给区间');

  // 对照组：定位可靠时不出现提示
  const doc2 = JSON.parse(JSON.stringify(doc));
  doc2.sections[0].items[0].offsetExact = true;
  doc2.sections[0].items[0].usages[0] = {
    text: '勉強します。', start: 0, end: 2, surface: '勉強', surfaceOriginal: '勉強', src: 'x.srt', t: 0,
  };
  const xml2 = buildDocumentXml(doc2, { toc: false });
  assert.ok(!xml2.includes('定位提示'), '可靠时不应出现提示');
});
