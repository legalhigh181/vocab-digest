import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLemmatizer, IRREGULAR } from '../src/lexicon/lemmatize.js';
import { extractCandidates } from '../src/extract.js';
import { extractPhrases } from '../src/phrases.js';
import { createClassifier, groupByPos, heuristicPos, posLabel } from '../src/classify.js';

const dict = new Set([
  'go', 'study', 'run', 'make', 'happy', 'move', 'stop', 'big', 'use', 'box', 'watch', 'try',
  'quick', 'careful', 'kind', 'able', 'create', 'relate', 'nation', 'nature', 'give', 'take', 'life',
]);
const lemma = createLemmatizer({ dictionary: dict });

test('词形还原：复数 / 过去式 / ing / 比较级', () => {
  assert.equal(lemma('studies'), 'study');
  assert.equal(lemma('moved'), 'move');
  assert.equal(lemma('running'), 'run');
  assert.equal(lemma('stopped'), 'stop');
  assert.equal(lemma('boxes'), 'box');
  assert.equal(lemma('watching'), 'watch');
  assert.equal(lemma('bigger'), 'big');
  assert.equal(lemma('happily'), 'happy');
  assert.equal(lemma('lives'), 'life');
});

test('词形还原：不规则表与例外表优先', () => {
  assert.equal(lemma('went'), 'go');
  assert.equal(lemma('made'), 'make');
  assert.equal(lemma('gave'), 'give');
  assert.equal(lemma('took'), 'take');
  assert.equal(lemma('us'), 'us');
  assert.equal(lemma('news'), 'news');
  assert.equal(lemma('going'), 'go');
});

test('词形还原：强后缀不依赖词典也能裁（词典里没有的实词）', () => {
  // 强后缀（-s/-ed/-ing）本来就不该要求词典佐证，否则 tokens/files/mechanisms 全都还原不了。
  // 裁完变成虚词时退回原词，避免 is→i / as→a 这种乱裁。
  assert.equal(lemma('wships'), 'wship');
  assert.equal(lemma('is'), 'is');
  assert.equal(lemma('as'), 'as');
  assert.ok(IRREGULAR.children === 'child');
});

test('词形还原：去 e 动词补回 e，不造 *stabiliz* / *teache*', () => {
  assert.equal(lemma('stabilizes'), 'stabilize');
  assert.equal(lemma('organized'), 'organize');
  assert.equal(lemma('decided'), 'decide');
  assert.equal(lemma('restored'), 'restore');
  assert.equal(lemma('teaching'), 'teach');
  assert.equal(lemma('pushing'), 'push');
  assert.equal(lemma('making'), 'make');
  assert.equal(lemma('improves'), 'improve');
  assert.equal(lemma('behaves'), 'behave');
  assert.equal(lemma('buses'), 'bus');
  assert.equal(lemma('glasses'), 'glass');
  assert.equal(lemma('knives'), 'knife');
  assert.equal(lemma('quizzes'), 'quiz');
});

test('候选抽取：合并复数与原形、累计样本与来源', () => {
  const frags = [
    { text: 'the dog runs fast', kind: 'danmaku', t: 1, src: 'a.xml' },
    { text: 'two dogs running', kind: 'danmaku', t: 2, src: 'a.xml' },
  ];
  const { candidates, dropped } = extractCandidates(frags, { minLen: 3, lemmatize: lemma, extraStop: new Set(['the']) });
  const run = candidates.get('run');
  assert.ok(run, 'run 应被还原出来');
  assert.equal(run.count, 2);
  assert.deepEqual(Object.keys(run.forms).sort(), ['running', 'runs']);
  assert.equal(candidates.get('dog').count, 2, 'dogs 应并入 dog（强后缀不需要词典佐证）');
  assert.deepEqual(Object.keys(candidates.get('dog').forms).sort(), ['dog', 'dogs']);
  assert.equal(dropped.stop >= 1, true);
  // 全大写普通词按刷屏丢弃
  const shoutOnly = extractCandidates([{ text: 'LOL LOL', kind: 'danmaku', src: 'a' }], { minLen: 3, dropShout: true });
  assert.equal(shoutOnly.candidates.size, 0);
  assert.ok(shoutOnly.dropped.shout >= 2);
});

test('短语抽取：跨句不连，两端须实词，PMI 与边界熵门槛', () => {
  const frags = [
    { text: 'neural network is good. neural network again', src: 'a', t: 1 },
    { text: 'neural network rocks', src: 'a', t: 2 },
    { text: 'the model is fast and the model is small', src: 'a', t: 3 },
  ];
  // 小样本里 PMI 天然偏低，先验证「结构规则」本身
  const { phrases } = extractPhrases(frags, {
    minN: 2, maxN: 3, minCount: 2, stopwords: new Set(['is', 'the', 'and']), minPmi: 0, minEntropy: 0,
  });
  const keys = phrases.map((p) => p.word);
  assert.ok(keys.includes('neural network'), '反复出现的搭配应被抽到');
  assert.ok(!keys.includes('network is'), '虚词不该出现在两端');
  assert.ok(!keys.includes('model is'), '虚词不该出现在两端');
  assert.ok(!keys.includes('model is fast'), '3 词以上窗口要求至少 2 个实词');
  // 带门槛时，PMI 太低的搭配要被丢掉
  const gated = extractPhrases(frags, {
    minN: 2, maxN: 3, minCount: 2, stopwords: new Set(['is', 'the', 'and']), minPmi: 3,
  });
  assert.equal(gated.phrases.length, 0, '小样本 PMI 不足 3，应被门槛拦下');
});

test('短语冗余：同频的短搭配被长搭配覆盖', () => {
  // 高频的 deep neural network 会把同频的 deep neural / neural network 吞掉，只留最长的
  const frags = [
    { text: 'deep neural network here', src: 'a' },
    { text: 'deep neural network rocks now', src: 'a' },
    { text: 'deep neural network again today', src: 'a' },
  ];
  const { phrases } = extractPhrases(frags, { minN: 2, maxN: 4, minCount: 2, minPmi: 0, minEntropy: 0 });
  const keys = phrases.map((p) => p.word);
  assert.ok(keys.includes('deep neural network'), '长搭配应保留');
  assert.ok(!keys.includes('deep neural'), '被更长且频次相同的短语覆盖');
});

test('短语 v2：缩略残片不进短语，白名单可强行保留', () => {
  const frags = [
    { text: "what' wrong with you", src: 'a' },
    { text: "nothing serious at all", src: 'a' },
    { text: "nothing serious okay", src: 'a' },
  ];
  const { phrases } = extractPhrases(frags, {
    minN: 2, maxN: 3, minCount: 2, stopwords: new Set(['with', 'you', 'at', 'all', 'okay']),
    whitelist: new Map([['nothing serious', { meaning: '没什么大不了', scene: ['看病'] }]]),
  });
  const keys = phrases.map((p) => p.word);
  assert.ok(!keys.some((k) => k.startsWith("what'")), '拆坏的 what\' 不应成短语');
  const wl = phrases.find((p) => p.word === 'nothing serious');
  assert.ok(wl, '白名单短语应被保留');
  assert.equal(wl.fromList, true);
  assert.deepEqual(wl.scene, ['看病']);
});

test('分类：POS 表 > decisions > 启发式 > other', () => {
  const clf = createClassifier({ pos: { compute: 'v.' }, decisions: { alpha: { pos: 'adj.' } }, base: new Set(['go']) });
  assert.equal(clf('compute').pos, 'v.');
  assert.equal(clf('alpha').pos, 'adj.');
  assert.equal(clf('nation').pos, 'n.');
  assert.equal(clf('happily').pos, 'adv.');
  assert.equal(clf('zzz').pos, 'other');
  assert.equal(clf('go').base, true);
});

test('分类：启发式与中文标签', () => {
  assert.equal(heuristicPos('quickly'), 'adv.');
  assert.equal(heuristicPos('careful'), 'adj.');
  assert.equal(heuristicPos('creation'), 'n.');
  assert.equal(posLabel('n.'), '名词');
  assert.equal(posLabel('phr.'), '短语');
  assert.equal(posLabel('weird'), '其他');
});

test('按词性分组：空组不出现，组内频次降序', () => {
  const groups = groupByPos([
    { word: 'b', pos: 'n.', count: 1 },
    { word: 'a', pos: 'n.', count: 5 },
    { word: 'c', pos: 'v.', count: 2 },
  ]);
  assert.deepEqual(groups.map((g) => g.key), ['n.', 'v.']);
  assert.deepEqual(groups[0].items.map((i) => i.word), ['a', 'b']);
});
