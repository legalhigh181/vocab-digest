// 探查 kuromoji 的真实输出形态，为 T3 设计取证（不写进源码，只用来读数据）。
import kuromoji from 'kuromoji';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const dicPath = join(here, '..', 'node_modules', 'kuromoji', 'dict');

const tokenizer = await new Promise((res, rej) => {
  kuromoji.builder({ dicPath }).build((err, tk) => (err ? rej(err) : res(tk)));
});

const samples = [
  '今日はいい天気ですね。',
  '彼は東京に住んでいます。',
  '先生に宿題を出された。',
  'コーヒーを飲みたかった。',
  '勉強することが好きです。',
  'ｺｰﾋｰｶｯﾌﾟ',           // 半角片假名
  '食べました',             // 活用
  '走った',                 // 五段过去
  '見てきた',               // てくる
  '猫が好き',               // 一字名词
  '手を洗う',
  'Vtuberとして活動しています',
  'ＳＮＳで話題になった',   // 全角英文
  'hello 世界',             // 混排
  '2024年3月1日',
  'えっ、本当？',
];

for (const text of samples) {
  console.log(`\n=== ${text} ===`);
  const toks = tokenizer.tokenize(text);
  let off = 0;
  for (const t of toks) {
    console.log(
      JSON.stringify({
        surface: t.surface_form,
        basic: t.basic_form,
        reading: t.reading ?? null,
        pron: t.pronunciation ?? null,
        pos: t.pos,
        posDetail1: t.pos_detail_1,
        posDetail2: t.pos_detail_2,
        conjType: t.conjugated_type ?? null,
        conjForm: t.conjugated_form ?? null,
        off,
      }),
    );
    off += t.surface_form.length; // UTF-16 长度
  }
}

// 未知词到底是什么样
console.log('\n=== 未知词探测 ===');
for (const w of ['ｺｰﾋｰ', 'あああああ', 'XYZXYZ', 'ぬぬぬぬ', 'ティラノサウルス']) {
  const [t] = tokenizer.tokenize(w);
  console.log(w, '->', JSON.stringify({ basic: t?.basic_form, reading: t?.reading, pos: t?.pos, posD1: t?.pos_detail_1 }));
}
