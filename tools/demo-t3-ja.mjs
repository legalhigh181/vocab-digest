// T3 真实分词输出样例：把内置的几段日文跑一遍，打印实际产生的词条。
// 这份输出直接贴进交付报告，不做任何美化。
import { digestJa } from '../src/ja/index.js';

const SENTENCES = [
  '今日はいい天気ですね。',
  '彼は東京に住んでいます。',
  '勉強することが好きです。',
  '先生に宿題を出された。',
  'コーヒーを飲みたかった。',
  'ｺｰﾋｰｶｯﾌﾟを買った',   // 半角片假名：NFKC 后应识别
  'Vtuberとして活動しています',
  '走った、走った。',       // 同形重复：走る 应合并，词性一致
  '猫が好き',               // 一字名词
  'えっ、本当？',
];

const fragments = SENTENCES.map((text, i) => ({ text, t: i * 3.5, src: 'sample.srt' }));
const config = { lexicon: { minLen: 1, minFreq: 1 }, docx: { samplePerWord: 2, usagePerWord: 3 } };

const result = await digestJa(fragments, config);

console.log(`分词器版本：kuromoji ${result.tokenizerVersion}`);
console.log(`片段 ${result.stats.fragmentCount} 条 → 词条 ${result.stats.itemCount} 个，token ${result.stats.tokenCount}`);
console.log(
  `未知词：${result.stats.unknownItemCount}/${result.stats.itemCount} 个词条`
  + `（${(result.stats.unknownItemRatio * 100).toFixed(1)}%），`
  + `${result.stats.unknownTokenCount}/${result.stats.tokenCount} 次`
  + `（${(result.stats.unknownTokenRatio * 100).toFixed(1)}%）`,
);
console.log('');
console.log('词条（按次数降序）：');
for (const it of result.items) {
  const flags = [
    it.unknown ? 'UNKNOWN' : '',
    it.lemmaSource === 'surface' ? 'lemma=surface' : '',
  ].filter(Boolean).join(' ');
  console.log(
    `  ${it.word.padEnd(10, '　')} ${it.pos.padEnd(7)} ×${String(it.count).padStart(2)}`
    + `  读音=${(it.reading || '—').padEnd(8)} 平假名=${(it.readingHiragana || '—').padEnd(8)}`
    + `  ${it.posDetail.padEnd(18)} ${flags}`,
  );
}

console.log('');
console.log('用法样例（带 UTF-16 半开区间与切片自检）：');
for (const it of result.items.slice(0, 4)) {
  for (const u of it.usages) {
    const slice = u.text.slice(u.start, u.end);
    const ok = slice === u.surface ? 'OK' : 'MISMATCH';
    console.log(
      `  ${it.word} → 「${u.text}」 [${u.start},${u.end}) = 「${slice}」 ${ok}`
      + `（期望「${u.surface}」）`,
    );
  }
}
