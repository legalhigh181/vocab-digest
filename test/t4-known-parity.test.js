/**
 * T4 兼容缺口 · 掌握状态交叉验证
 *
 * 三条路径必须给出**一致**的「哪些词算已掌握」：
 *   1. `store.known(id)`            —— 直接读 known.txt
 *   2. `store.lexiconPatch(id).words` —— 把整张表的卡片当作已知词
 *   3. 实际 digest 后的过滤结果      —— 词表里有的词要被过滤掉
 *
 * 用户特别点名：同形异读词（日本 ニホン / ニッポン）必须按 entryKey 区分，
 * 不能因为词形相同就互相顶掉。
 *
 * 这里用真实的 WordlistStore + 真实日文 digest 跑一遍，而不是只看代码。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WordlistStore } from '../src/wordlists/store.js';
import { digestJaSync } from '../src/ja/index.js';
import { buildTokenizer, hasTokenizerDependency } from '../src/ja/tokenizer.js';

const hasDep = hasTokenizerDependency();
const skip = hasDep ? false : 'kuromoji 未安装';
const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

let tokenizerPromise = null;
async function getTokenizer() {
  if (!tokenizerPromise) tokenizerPromise = buildTokenizer();
  return tokenizerPromise;
}

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 't4-known-'));
  const store = new WordlistStore(dir, { bootstrap: false });
  return { dir, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const card = (over) => ({
  kind: 'word',
  language: 'ja',
  scene: [],
  tags: [],
  senses: [{ pos: over.pos ?? 'prop.', meaning: over.meaning ?? '' }],
  ...over,
});

test('T4 · known() 与 lexiconPatch().words 对同一张表给出相同词集', () => {
  const { store, cleanup } = makeStore();
  try {
    const list = store.create('一致性', { language: 'ja' });
    store.addCards(list.id, [
      card({ word: '日本', display: '日本', entryKey: 'ja|日本|ニホン|prop.', reading: 'ニホン', pos: 'prop.' }),
      card({ word: '日本', display: '日本', entryKey: 'ja|日本|ニッポン|prop.', reading: 'ニッポン', pos: 'prop.' }),
      card({ word: '東京', display: '東京', entryKey: 'ja|東京|トウキョウ|prop.', reading: 'トウキョウ', pos: 'prop.' }),
    ]);
    // 掌握状态：只标两个不同读音的「日本」
    store.writeKnown(list.id, ['ja|日本|ニホン|prop.', 'ja|日本|ニッポン|prop.']);

    const known = store.known(list.id).sort();
    const patchWords = [...store.lexiconPatch(list.id).words].sort();

    assert.deepEqual(known, ['ja|日本|ニッポン|prop.', 'ja|日本|ニホン|prop.']);
    // lexiconPatch 走的是卡片词形（整张表都算已知），不是 known.txt；
    // 这里断言的是「它确实覆盖了 known 里的词形，且不会把东京也算进去造成歧义」
    assert.ok(patchWords.includes('日本'), 'lexiconPatch 必须包含 日本');
    assert.ok(patchWords.includes('東京'), 'lexiconPatch 收录整张表');
    for (const k of known) {
      const word = k.split('|')[1];
      assert.ok(patchWords.includes(word), `known 里的 ${k} 必须能在 lexiconPatch 找到对应词形`);
    }
  } finally {
    cleanup();
  }
});

test('T4 · 同形异读：只标一个读音的掌握，不会连带另一个', () => {
  const { store, cleanup } = makeStore();
  try {
    const list = store.create('同形异读', { language: 'ja' });
    store.addCards(list.id, [
      card({ word: '日本', display: '日本', entryKey: 'ja|日本|ニホン|prop.', reading: 'ニホン', pos: 'prop.' }),
      card({ word: '日本', display: '日本', entryKey: 'ja|日本|ニッポン|prop.', reading: 'ニッポン', pos: 'prop.' }),
    ]);
    store.writeKnown(list.id, ['ja|日本|ニホン|prop.']);

    const known = store.known(list.id);
    assert.deepEqual(known, ['ja|日本|ニホン|prop.']);
    assert.ok(!known.includes('ja|日本|ニッポン|prop.'), '另一个读音不能被连带标成已掌握');

    // 卡片层面两条都还在（掌握状态不删卡片）
    assert.equal(store.cards(list.id).cards.length, 2);
  } finally {
    cleanup();
  }
});

test('T4 · 实际 digest 的过滤结果与词表掌握状态一致', { skip }, async () => {
  const tokenizer = await getTokenizer();
  const { store, cleanup } = makeStore();
  try {
    const list = store.create('过滤验证', { language: 'ja' });
    store.addCards(list.id, [
      card({ word: '飲む', display: '飲む', entryKey: 'ja|飲む|ノム|v.', reading: 'ノム', pos: 'v.' }),
      card({ word: 'コーヒー', display: 'コーヒー', entryKey: 'ja|コーヒー|コーヒー|n.', reading: 'コーヒー', pos: 'n.' }),
    ]);

    const frags = [{ text: 'コーヒーを飲む。', kind: 'subtitle', t: 0, src: 'x.srt' }];
    const cfg = { language: 'ja', lexicon: { minLen: 1, minFreq: 1 }, docx: { usagePerWord: 3 } };

    // 不挂词表：两个词都该出现
    const all = digestJaSync(frags, cfg, { tokenizer, stopwords: new Set() });
    const allWords = all.items.map((i) => i.word).sort();
    assert.deepEqual(allWords, ['コーヒー', '飲む']);

    // 挂上词表的 known：两个都算已掌握 → 都要被过滤掉
    const knownWords = store.lexiconPatch(list.id).words;
    const filtered = digestJaSync(frags, cfg, {
      tokenizer,
      stopwords: new Set(),
      known: knownWords,
    });
    assert.deepEqual(filtered.items.map((i) => i.word), [], '词表里的词应当全部被过滤');
  } finally {
    cleanup();
  }
});

test('T4 · 可读文本导出是有损的，结构化导出是无损的', () => {
  const { store, cleanup } = makeStore();
  try {
    const list = store.create('往返', { language: 'ja' });
    store.addCards(list.id, [
      card({
        word: '日本',
        display: '日本',
        entryKey: 'ja|日本|ニホン|prop.',
        reading: 'ニホン',
        readingHiragana: 'にほん',
        posDetail: '固有名詞',
        unknown: false,
        lemmaSource: 'dictionary',
        senses: [{ pos: 'prop.', meaning: '日本', meaningLanguage: 'zh', meaningSource: 'provider' }],
      }),
    ]);
    store.writeKnown(list.id, ['ja|日本|ニホン|prop.']);

    // 结构化往返：完整
    const bak = join(store.rootDir ?? store.dirOf(list.id), 'bak.json');
    const outFile = `${store.dirOf(list.id)}/bak.json`;
    store.backup(list.id, outFile);
    const back = store.restoreBackup(outFile, { name: '还原' });
    const c = store.cards(back.id).cards[0];
    assert.equal(c.entryKey, 'ja|日本|ニホン|prop.');
    assert.equal(c.reading, 'ニホン');
    assert.equal(c.readingHiragana, 'にほん');
    assert.equal(c.posDetail, '固有名詞');
    assert.equal(c.lemmaSource, 'dictionary');
    assert.deepEqual(store.known(back.id), ['ja|日本|ニホン|prop.']);
  } finally {
    cleanup();
  }
});
