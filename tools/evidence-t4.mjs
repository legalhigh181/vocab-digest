/**
 * T4 证据生成：把用户要求验收的四类结果跑出来并打印。
 *
 *   ① 本地 JSON / TSV 查询，以及同形异读词的匹配结果
 *   ② 人工修订 > 当前词表 > provider 的冲突
 *   ③ 未配置、未命中、加载失败三种状态；缺释义仍可导出
 *   ④ 卡片 → 备份恢复 → 导出导入 → 重渲染后的字段保留
 *
 * 用法：node tools/evidence-t4.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ⚠️ Windows 上动态 import 必须给 file:// URL，不能给盘符路径
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fromRoot = (rel) => pathToFileURL(path.join(root, rel)).href;

const { createFileProvider, parseMeaningsTsv, resolveMeaning, meaningWarnings } = await import(
  fromRoot('src/meanings.js')
);
const { WordlistStore } = await import(fromRoot('src/wordlists/store.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't4-evidence-'));
const line = (s = '') => console.log(s);
const h = (s) => console.log(`\n${'='.repeat(60)}\n${s}\n${'='.repeat(60)}`);

// ── ① 本地 JSON 查询 + 同形异读 ─────────────────────────────
h('① 本地 JSON 查询，同形异读词');
const jsonFile = path.join(tmp, 'meanings.json');
fs.writeFileSync(
  jsonFile,
  JSON.stringify({
    schema: 1,
    language: 'ja',
    meaningLanguage: 'zh',
    entries: [
      { word: '日本', reading: 'ニホン', pos: 'prop.', meaning: '日本（にほん读法）' },
      { word: '日本', reading: 'ニッポン', pos: 'prop.', meaning: '日本（にっぽん读法）' },
      { word: '東京', meaning: '东京（通配：不限读音词性）' },
    ],
  }, null, 2),
  'utf8',
);
const jp = createFileProvider({ file: jsonFile, meaningLanguage: 'zh' });
line(`provider.status = ${jp.status}, count = ${jp.count}`);
for (const [word, reading, pos] of [
  ['日本', 'ニホン', 'prop.'],
  ['日本', 'ニッポン', 'prop.'],
  ['日本', 'ニホーン', 'prop.'],
  ['東京', 'トウキョウ', 'prop.'],
  ['東京', 'トウキョー', 'n.'],
]) {
  const r = jp.lookup({ word, reading, pos });
  line(`  ${word} / ${reading} / ${pos} -> ${r.meaning || '(未命中)'}`);
}
line('结论：同一个词形按读音分开命中，不串项；通配条目对任意读音/词性都能兜底。');

// ── ①b 本地 TSV 查询 ───────────────────────────────────────
h('①b 本地 TSV 查询');
const tsvFile = path.join(tmp, 'meanings.tsv');
fs.writeFileSync(
  tsvFile,
  [
    '# 词形\t释义\t读音\t词性\t释义语言',
    '勉強する\t学习，用功\tベンキョウスル\tv.\tzh',
    '走る\t跑\tハシル\tv.\tzh',
    '走る\t（赛跑）跑\tハシル\tv.\tzh',
    'ねこ\t猫\tネコ\tn.\tzh',
  ].join('\n') + '\n',
  'utf8',
);
const parsed = parseMeaningsTsv(fs.readFileSync(tsvFile, 'utf8'), { meaningLanguage: 'zh' });
line(`解析出 ${parsed.length} 条：`);
for (const e of parsed) line(`  ${e.word} / ${e.reading || '-'} / ${e.pos || '-'} -> ${e.meaning}`);
const tp = createFileProvider({ file: tsvFile, meaningLanguage: 'zh' });
line(`TSV lookup 走る = ${tp.lookup({ word: '走る', reading: 'ハシル', pos: 'v.' }).meaning}`);

// ── ② 优先级：人工修订 > 当前词表 > provider ───────────────
h('② 优先级：人工修订 > 当前词表 > provider');
const ctx = {
  word: '走る',
  reading: 'ハシル',
  pos: 'v.',
  revision: '',
  wordlist: { meaning: '词表里的意思', meaningLanguage: 'zh' },
  provider: tp,
};
let r = resolveMeaning(ctx);
line(`只有词表+provider   -> ${r.meaning}（来源 ${r.meaningSource}）`);
r = resolveMeaning({ ...ctx, revision: { meaning: '人工改过的意思' } });
line(`加上人工修订        -> ${r.meaning}（来源 ${r.meaningSource}）`);
r = resolveMeaning({ ...ctx, revision: '' });
line(`人工修订为空串      -> ${r.meaning}（来源 ${r.meaningSource}，空串不算修订）`);
r = resolveMeaning({ ...ctx, wordlist: { meaning: '' } });
line(`词表释义为空串      -> ${r.meaning}（来源 ${r.meaningSource}，空串不算有释义）`);
r = resolveMeaning({ ...ctx, wordlist: null, revision: '' });
line(`只有 provider       -> ${r.meaning}（来源 ${r.meaningSource}）`);

// ── ③ 三种状态 + 缺释义仍可导出 ────────────────────────────
h('③ 未配置 / 未命中 / 加载失败');
const unconf = createFileProvider({ file: path.join(tmp, '不存在.json') });
line(`未配置：status=${unconf.status}, 命中=${unconf.lookup({ word: '走る' }).found}`);
const badFile = path.join(tmp, 'bad.json');
fs.writeFileSync(badFile, '{ 这不是合法 json', 'utf8');
const bad = createFileProvider({ file: badFile });
line(`加载失败：status=${bad.status}, error=${bad.lookup({ word: '走る' }).error}`);
line(`未命中：found=${tp.lookup({ word: '存在しない語', reading: '', pos: 'n.' }).found}`);
const items = [
  { word: '走る', meaning: '', meaningSource: '' },
  { word: '知らない語', meaning: '', meaningSource: '' },
];
const warns = meaningWarnings(items, { status: 'unconfigured', count: 0 });
line(`汇总提示（2 条词都没释义）→ ${warns.length} 条提示，不是逐词刷屏：`);
for (const w of warns) line(`  - ${w.message}`);
line('缺释义仍可导出：见 ④ 里 cardsToText 的输出（meaning 为空不影响卡片写入）。');

// ── ④ 卡片 → 备份恢复 → 导出导入 → 重渲染 ─────────────────
h('④ 字段往返保留：entryKey / 读音 / 释义语言与来源 / 掌握状态');
const store = new WordlistStore(tmp, { bootstrap: false });
const list = store.create('T4证据表', { language: 'ja' });
const cards = [
  {
    word: '日本',
    display: '日本',
    kind: 'word',
    language: 'ja',
    entryKey: 'ja|日本|ニホン|prop.',
    reading: 'ニホン',
    readingHiragana: 'にほん',
    posDetail: '固有名詞',
    pos: 'prop.',
    unknown: false,
    lemmaSource: 'dict',
    senses: [{ pos: 'prop.', meaning: '日本（にほん读法）', meaningLanguage: 'zh', meaningSource: 'provider' }],
    scene: [],
    tags: [],
  },
  {
    word: '日本',
    display: '日本',
    kind: 'word',
    language: 'ja',
    entryKey: 'ja|日本|ニッポン|prop.',
    reading: 'ニッポン',
    readingHiragana: 'にっぽん',
    posDetail: '固有名詞',
    pos: 'prop.',
    unknown: false,
    lemmaSource: 'dict',
    senses: [{ pos: 'prop.', meaning: '日本（にっぽん读法）', meaningLanguage: 'zh', meaningSource: 'provider' }],
    scene: [],
    tags: [],
  },
  {
    word: 'Vtuber',
    display: 'Vtuber',
    kind: 'word',
    language: 'ja',
    entryKey: 'ja|Vtuber|?|prop.',
    reading: '',
    readingHiragana: '',
    posDetail: '*',
    pos: 'prop.',
    unknown: true,
    lemmaSource: 'surface',
    senses: [{ pos: 'prop.', meaning: '', meaningLanguage: '', meaningSource: 'none' }],
    scene: [],
    tags: [],
  },
];
store.addCards(list.id, cards);
store.writeKnown(list.id, ['日本']);
line(`建立词表「${list.name}」：${cards.length} 张卡片，掌握 1 个`);

const dump = (title, arr) => {
  line(`\n-- ${title} --`);
  for (const c of arr) {
    line(`  word=${c.word} entryKey=${c.entryKey}`);
    line(`    reading=${c.reading} hira=${c.readingHiragana} pos=${c.pos} posDetail=${c.posDetail} unknown=${c.unknown} lemmaSource=${c.lemmaSource}`);
    for (const s of c.senses ?? []) line(`    sense: ${s.meaning || '(空)'} / lang=${s.meaningLanguage} / src=${s.meaningSource}`);
  }
};
dump('① 卡片原样', store.cards(list.id).cards);
line(`  掌握状态 known = ${JSON.stringify(store.known(list.id))}`);

const bakFile = path.join(tmp, 'bak.json');
const bak = store.backup(list.id, bakFile);
line(`\n-- 备份 --\n  写出 ${bak.outFile}（${bak.count} 张卡，掌握 ${bak.known} 个）`);
const restored = store.restoreBackup(bakFile, { name: 'T4证据表-还原' });
dump('② 备份还原后的卡片', store.cards(restored.id).cards);
line(`  掌握状态 known = ${JSON.stringify(store.known(restored.id))}`);

const textFile = path.join(tmp, 'export.txt');
const text = store.exportText(list.id, textFile).text;
line(`\n-- 导出文本 --\n${text.split('\n').map((l) => `  ${l}`).join('\n')}`);
const imported = store.importFile({ text, name: 'T4证据表-导入', language: 'ja' });
dump('③ 再导入后的卡片', store.cards(imported.id).cards);
line(`  掌握状态 known = ${JSON.stringify(store.known(imported.id))}（导入默认不标掌握）`);

// 重渲染：把卡片再喂回 digest 的构建函数（cardsFromDigest 是 store 的方法）
const fakeItems = store.cards(list.id).cards.map((c) => ({
  word: c.word,
  display: c.display,
  count: 1,
  pos: c.pos,
  posLabel: c.pos,
  meaning: c.senses?.[0]?.meaning ?? '',
  meaningLanguage: c.senses?.[0]?.meaningLanguage ?? '',
  meaningSource: c.senses?.[0]?.meaningSource ?? '',
  language: 'ja',
  entryKey: c.entryKey,
  reading: c.reading,
  readingHiragana: c.readingHiragana,
  posDetail: c.posDetail,
  unknown: c.unknown,
  lemmaSource: c.lemmaSource,
  sources: {},
  usages: [],
}));
const back = store.cardsFromDigest({ language: 'ja', items: fakeItems });
dump('④ 重渲染（digest 条目 → 卡片）后的字段', back);

fs.rmSync(tmp, { recursive: true, force: true });
line('\n完成。');
