// T0 探针（正式版，可重复执行）：验证 kuromoji 是否可加载、词法行为是否符合 ADR-0001
// 用法：node tools/probe-ja-tokenizer.mjs
// 输出人类可读报告；不写任何项目数据，只在内存中工作。

import { fileURLToPath } from 'node:url';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '[ok]' : '[FAIL]'} ${name}${detail ? ' — ' + detail : ''}`);
}

let kuromoji;
try {
  kuromoji = (await import('node:module')).createRequire(import.meta.url)('kuromoji');
} catch (e) {
  console.log('[FAIL] 无法 require kuromoji:', e.message);
  console.log('提示：先执行 npm install（锁定 kuromoji@0.1.2）');
  process.exit(1);
}

const dicPathWin = fileURLToPath(new URL('../node_modules/kuromoji/dict/', import.meta.url));

const t0 = Date.now();
const tokenizer = await new Promise((res, rej) => {
  kuromoji.builder({ dicPath: dicPathWin }).build((err, tok) => (err ? rej(err) : res(tok)));
});
const loadMs = Date.now() - t0;
check('词典加载', true, `${loadMs} ms，RSS ${(process.memoryUsage().rss / 1024 / 1024).toFixed(0)} MB`);

function tok(text) {
  return tokenizer.tokenize(text);
}

// 1. 基本形还原
{
  const t = tok('昨昨日、猫が魚を食べました。');
  const tabeta = t.find((x) => x.surface_form === '食べ');
  check('食べました 的 basic_form 是 食べる', tabeta && tabeta.basic_form === '食べる', tabeta ? `${tabeta.surface_form} → ${tabeta.basic_form}` : '未找到');
  check(
    '活用词 reading 不等于原形读音（提示需另行取读音）',
    tabeta && tabeta.reading !== 'タベル',
    tabeta ? `token.reading=${tabeta.reading}` : '',
  );
}

// 2. 助词/助动词可识别，便于过滤
{
  const t = tok('猫が魚を食べる');
  const particles = t.filter((x) => x.pos === '助詞').map((x) => x.surface_form);
  check('助词可识别', particles.length === 2, particles.join('/'));
  const nouns = t.filter((x) => x.pos === '名詞').map((x) => x.surface_form);
  check('名词可识别', nouns.join('/') === '猫/魚', nouns.join('/'));
}

// 3. 未知词标记
{
  const t = tok('ｺｰﾋｰ');
  const unknown = t.filter((x) => x.basic_form === '*');
  check('半角片假名直接分词会落到未知词（需先 NFKC）', unknown.length > 0, t.map((x) => `${x.surface_form}=>${x.basic_form}`).join(' '));
  const t2 = tok('コーヒー');
  check('全角片假名可正常识别', t2[0] && t2[0].basic_form === 'コーヒー', `${t2[0]?.surface_form} → ${t2[0]?.basic_form} reading=${t2[0]?.reading}`);
}

// 4. サ変動詞需要合并
{
  const t = tok('勉強した');
  const hasSuru = t.some((x) => x.basic_form === 'する');
  check('勉強した 拆成 勉強 + する（需合并成 勉強する）', hasSuru, t.map((x) => `${x.surface_form}/${x.pos}/${x.pos_detail_1}`).join(' '));
}

// 5. 一字词保留
{
  const t = tok('猫と手');
  const singles = t.filter((x) => x.pos === '名詞' && [...x.surface_form].length === 1).map((x) => x.surface_form);
  check('单字名词可抽取', singles.length === 2, singles.join('/'));
}

// 6. 原形读音查询可行性
{
  const probe = tok('食べる');
  check('原形读音可查', probe[0] && probe[0].reading === 'タベル', probe[0] ? `${probe[0].surface_form} reading=${probe[0].reading}` : '');
}

const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`探针结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log('失败项：' + failed.map((f) => f.name).join('; '));
  process.exitCode = 1;
}
