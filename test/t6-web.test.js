/**
 * T6 · Web 接口层契约测试（不起浏览器，只打 HTTP）
 *
 * 覆盖 T6 待办：
 *   - 语言选择入口：新建词表时带 language、state 里能读到、索引文件里真落下
 *   - 词条展示层：日文运行经 /api/view 返回 reading / readingHiragana / unknown，
 *     且绝不拿英文字典（phonetic / dictMeaning / cambridge）去凑日文
 *   - 语言不串：日文运行与英文运行各自返回自己的 language
 *   - 重出 Word：显式 language 只改呈现，不重新分词
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startApp } from '../src/app/server.js';
import { renderRun, runDigest, runDigestAsync } from '../src/run.js';

const FIXTURE_EN = readFileSync(new URL('./fixtures/lecture.srt', import.meta.url));

const JA_SRT_TEXT = [
  '1',
  '00:00:01,000 --> 00:00:04,000',
  '日本の学生は毎日勉強します。',
  '',
  '2',
  '00:00:04,500 --> 00:00:08,000',
  'ワクワクする気持ちを大切に。',
  '',
].join('\r\n');

const tmp = mkdtempSync(join(tmpdir(), 'vocab-t6-web-'));
const servers = [];

after(() => {
  for (const s of servers) {
    try { s.server.close(); } catch { /* 已关 */ }
  }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows 偶发占用 */ }
});

/** 建一个独立工作区，写进 srt，返回 {cwd, en, ja} */
async function workspace(tag) {
  const cwd = mkdtempSync(join(tmp, `${tag}-`));
  const enSrt = join(cwd, 'lecture.srt');
  writeFileSync(enSrt, FIXTURE_EN);
  const jaSrt = join(cwd, 'ja.srt');
  writeFileSync(jaSrt, JA_SRT_TEXT, 'utf8');
  const en = runDigest({ inputs: [enSrt], cwd, runId: `${tag}-en`, language: 'en' });
  const ja = await runDigestAsync({ inputs: [jaSrt], cwd, runId: `${tag}-ja`, language: 'ja' });
  return { cwd, en, ja };
}

async function boot(cwd) {
  const app = await startApp({ cwd, port: 0 });
  servers.push(app);
  return app;
}

async function post(app, path, body) {
  const r = await fetch(new URL(path, app.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return r.json();
}

async function get(app, path) {
  const r = await fetch(new URL(path, app.url));
  return r.json();
}

test('T6 · Web 日文运行返回读音与假名，英文运行不受影响', async () => {
  const { cwd, en, ja } = await workspace('a');
  assert.equal(ja.language, 'ja');
  assert.equal(en.language, 'en');
  const app = await boot(cwd);

  // 1) state：每个运行带自己的 language
  const st = await get(app, '/api/state');
  assert.equal(st.ok, true);
  const runJa = st.runs.find((r) => r.runId === 'a-ja');
  const runEn = st.runs.find((r) => r.runId === 'a-en');
  assert.ok(runJa, '日文运行应出现在历史里');
  assert.ok(runEn, '英文运行应出现在历史里');
  assert.equal(runJa.language, 'ja');
  assert.equal(runEn.language, 'en');

  // 2) 日文视图：读音 / 假名 / entryKey
  const vJa = await get(app, '/api/view?runId=a-ja');
  assert.equal(vJa.ok, true);
  assert.equal(vJa.language, 'ja');
  const jp = vJa.items.find((it) => it.display === '日本' || it.word === '日本');
  assert.ok(jp, '应抽到「日本」');
  // 读音来自 kuromoji 词典（它给「日本」标的是 ニッポン），我们原样透出、不自己改写
  assert.ok(jp.reading.length > 0, '日文词条必须带读音');
  assert.ok(/^[ァ-ヶー]+$/.test(jp.reading), `读音应是片假名：${jp.reading}`);
  assert.ok(/^[ぁ-ゖー]+$/.test(jp.readingHiragana), `假名应是平假名：${jp.readingHiragana}`);
  // 同一词形的两种写法必须互相对得上（片假名→平假名是纯字符映射）
  assert.equal(
    jp.readingHiragana,
    [...jp.reading].map((ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60)).join(''),
    '平假名应由片假名逐字映射得到',
  );
  assert.equal(jp.unknown, false);
  assert.equal(jp.language, 'ja');
  // 日文绝不去英文字典里找音标和剑桥链接
  assert.equal(jp.phonetic, '');
  assert.equal(jp.dictMeaning, '');
  assert.equal(jp.cambridge, '');
  // 每条都带 entryKey，前端高亮靠它而不是靠 word（同形异读要分得开）
  assert.ok(vJa.items.every((it) => typeof it.entryKey === 'string' && it.entryKey !== ''));
  // unknown 的词条：不编读音、不编假名
  for (const it of vJa.items.filter((x) => x.unknown === true)) {
    assert.equal(it.reading, '', 'unknown 的词不编读音');
    assert.equal(it.readingHiragana, '', 'unknown 的词不编假名');
  }

  // 3) 英文视图：不串日文字段，剑桥链接照旧
  const vEn = await get(app, '/api/view?runId=a-en');
  assert.equal(vEn.language, 'en');
  assert.ok(vEn.items.length > 0);
  for (const it of vEn.items) {
    assert.equal(it.reading, '');
    assert.equal(it.readingHiragana, '');
    assert.equal(it.unknown, false);
    assert.ok(it.cambridge.startsWith('https://dictionary.cambridge.org/'), `英文条目应有剑桥链接：${it.word}`);
  }
});

test('T6 · 日文可按假名搜索', async () => {
  const { cwd } = await workspace('b');
  const app = await boot(cwd);

  // 用平假名搜：hay 里含 readingHiragana 才能命中
  const target = (await get(app, '/api/view?runId=b-ja')).items.find((it) => it.word === '日本');
  assert.ok(target, '应抽到「日本」');
  const v = await get(app, `/api/view?runId=b-ja&q=${encodeURIComponent(target.readingHiragana)}`);
  assert.equal(v.ok, true);
  assert.ok(v.items.some((it) => it.word === '日本'), '按平假名应搜到「日本」');
  assert.ok(v.items.every((it) => it.language === 'ja'));

  // 用片假名读音搜，同样要能命中
  const v2 = await get(app, `/api/view?runId=b-ja&q=${encodeURIComponent(target.reading)}`);
  assert.ok(v2.items.some((it) => it.word === '日本'));
});

test('T6 · 新建词表可以选语言，state 与索引文件都读得回来', async () => {
  const cwd = mkdtempSync(join(tmp, 'c-'));
  const app = await boot(cwd);

  const r = await post(app, '/api/wordlist/create', { name: '日语表', language: 'ja' });
  assert.equal(r.ok, true);
  assert.equal(r.language, 'ja');

  const r2 = await post(app, '/api/wordlist/create', { name: '英语表', language: 'en' });
  assert.equal(r2.ok, true);
  assert.equal(r2.language, 'en');

  // 不传 language：默认英文，不能变成 undefined 落进索引
  const r3 = await post(app, '/api/wordlist/create', { name: '默认表' });
  assert.equal(r3.ok, true);
  assert.equal(r3.language, 'en');

  const st = await get(app, '/api/state');
  const byName = Object.fromEntries(st.lists.map((l) => [l.name, l.language]));
  assert.equal(byName['日语表'], 'ja');
  assert.equal(byName['英语表'], 'en');
  assert.equal(byName['默认表'], 'en');

  // 索引文件里也要真的落下 language（不是只活在 HTTP 响应里）
  const idx = JSON.parse(readFileSync(join(cwd, 'data', 'wordlists', '索引.json'), 'utf8'));
  const entry = idx.lists.find((l) => l.name === '日语表');
  assert.equal(entry.language, 'ja');
});

test('T6 · 日文词条加入词表后读出读音与 entryKey', async () => {
  const { cwd } = await workspace('d');
  const app = await boot(cwd);

  const created = await post(app, '/api/wordlist/create', { name: '日表', language: 'ja' });
  assert.equal(created.ok, true);
  const id = created.listId;
  const add = await post(app, '/api/wordlist/add', {
    id,
    cards: [{
      word: '日本', display: '日本', language: 'ja', entryKey: 'ja|日本|ニホン|prop.',
      reading: 'ニホン', readingHiragana: 'にほん', unknown: false,
      // 词表卡片的释义挂在 senses 上，不传会让 store.addCards 抛 "c.senses is not iterable"
      senses: [{ pos: 'prop.', meaning: '日本' }],
    }],
  });
  assert.equal(add.ok, true);

  const cards = await post(app, '/api/wordlist/cards', { id });
  assert.equal(cards.ok, true);
  const card = cards.cards.find((c) => c.word === '日本');
  assert.ok(card, '应能在词表里找到「日本」');
  assert.equal(card.reading, 'ニホン');
  assert.equal(card.readingHiragana, 'にほん');
  assert.equal(card.unknown, false);
  assert.equal(card.language, 'ja');
});

test('T6 · 显式 language 冲突被拒绝，同语言与省略都正常', async () => {
  const { cwd, ja } = await workspace('e');
  const runDir = ja.runDir;
  const digPath = join(runDir, 'digest.json');
  const before = JSON.parse(readFileSync(digPath, 'utf8'));
  const wordsBefore = before.items.map((i) => i.word);

  // ① 冲突（ja 运行 + en）：明确拒绝，且不得改写原运行、不得碰已有文档
  const beforeText = readFileSync(digPath, 'utf8');
  const docxPath = join(runDir, 'vocab.docx');
  const docxBefore = existsSync(docxPath) ? readFileSync(docxPath) : null;
  assert.throws(
    () => renderRun({ cwd, runDir, configOverrides: { language: 'en' } }),
    (e) => e.code === 'LANGUAGE_CONFLICT',
    '日文运行用 en 重渲染必须报 LANGUAGE_CONFLICT',
  );
  assert.equal(readFileSync(digPath, 'utf8'), beforeText, '被拒绝时不得改写 digest.json');
  if (docxBefore) {
    assert.ok(readFileSync(docxPath).equals(docxBefore), '被拒绝时不得重写已有文档');
  }

  // ② 同语言：正常渲染，且是日语排版
  const same = renderRun({ cwd, runDir, configOverrides: { language: 'ja' } });
  const failed = same.verify.checks.filter((c) => c.status === 'fail');
  assert.equal(same.verify.ok, true, `同语言重渲染自检应通过：${JSON.stringify(failed)}`);
  assert.equal(same.docModel.language, 'ja', '同语言渲染必须落在 ja');
  assert.equal(same.docModel.eastAsiaFont, 'Meiryo');

  // ③ 省略：沿用运行自己的语言
  const plain = renderRun({ cwd, runDir });
  assert.ok(existsSync(plain.docxPath));
  assert.equal(plain.docModel.language, 'ja', '省略语言时应沿用 ja');

  // ④ 无论如何都不重新分词
  const after = JSON.parse(readFileSync(digPath, 'utf8'));
  assert.deepEqual(after.items.map((i) => i.word), wordsBefore, '重渲染不能重新分词');
});
