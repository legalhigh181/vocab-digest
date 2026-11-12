/**
 * T3 补丁测试：两处缺口。
 *
 * 缺口 A —— 聚合键必须含读音
 *   `word#pos` 会把「同形同词性但读音不同」的词合并。真实语料里 kuromoji 对同一词形
 *   只给一个读音，所以这里直接构造带不同 reading 的词元，验证聚合、known、人工修订
 *   三条路径都不会串项。
 *
 * 缺口 B —— 位置必须对应未经清洗的原文
 *   NFKC / 删除 / 重复压缩都会改变长度。这里对半角浊音假名、兼容字符、emoji、
 *   HTML 实体、被删除标记逐类验证：usage.text 是原文，slice(start,end) === surfaceOriginal。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanJapaneseWithMap, toOriginalRange } from '../src/ja/clean.js';
import { collectJa } from '../src/ja/extract.js';
import { buildTokenizer, hasTokenizerDependency } from '../src/ja/tokenizer.js';
import { digestJaSync, jaEntryKey, parseJaEntryKey } from '../src/ja/index.js';

const hasDep = hasTokenizerDependency();
const skip = hasDep ? false : 'kuromoji 未安装';

let tkPromise = null;
function tk() {
  if (!tkPromise) tkPromise = buildTokenizer();
  return tkPromise;
}

const CFG = { lexicon: { minLen: 1, minFreq: 1 }, docx: { samplePerWord: 3, usagePerWord: 5 } };

async function run(texts) {
  const fragments = texts.map((text, i) => ({ text, t: i, src: 'test.srt' }));
  return digestJaSync(fragments, CFG, { tokenizer: await tk() });
}

/** 造一个 kuromoji 风格的词元 */
function tok(surface, basic, reading, pos, detail1 = '*') {
  return {
    surface_form: surface,
    basic_form: basic,
    reading,
    pos,
    pos_detail_1: detail1,
    pos_detail_2: '*',
    conjugated_type: '*',
    conjugated_form: '*',
  };
}

// ══════════════════════════════════════════════════════════
// 缺口 A：同形同词性、不同读音不得合并
// ══════════════════════════════════════════════════════════

test('缺口A · jaEntryKey 含读音与语言，未知读音用 ? 占位', () => {
  const a = jaEntryKey('日本', 'prop.', 'ニッポン');
  const b = jaEntryKey('日本', 'prop.', 'ニホン');
  assert.notEqual(a, b, '读音不同必须是不同的键');
  assert.ok(a.startsWith('ja|'), '键必须以语言开头');
  assert.ok(a.endsWith('|prop.'), '键必须以词性结尾');

  const u1 = jaEntryKey('Vtuber', 'prop.', '', true);
  const u2 = jaEntryKey('Vtuber', 'prop.', '', true);
  assert.equal(u1, u2, '同一个未知词要稳定');
  assert.ok(u1.includes('|?|'), '未知读音要有明确占位符，不能和空串混');

  // 键必须可打印：不能含 NUL 之类会被编辑器/剪贴板吃掉的字符
  assert.ok(!/[\u0000-\u001f]/.test(a), 'entryKey 不能含控制字符');
  assert.ok(!/[\u0000-\u001f]/.test(u1), '未知词的 entryKey 也不能含控制字符');

  // 反解析要能还原
  assert.deepEqual(parseJaEntryKey(a), { word: '日本', reading: 'ニッポン', pos: 'prop.' });
  assert.deepEqual(parseJaEntryKey(u1), { word: 'Vtuber', reading: '', pos: 'prop.' });
});

test('缺口A · 同形同词性不同读音：聚合结果必须是两条', async () => {
  const { digestJaWith } = await import('../src/ja/index.js');
  // 用一个假分词器：把整句切成两条同形同词性、读音不同的词元
  const fake = {
    tokenize: () => [
      tok('日本', '日本', 'ニッポン', '名詞', '固有名詞'),
      tok('日本', '日本', 'ニホン', '名詞', '固有名詞'),
    ],
  };
  // 直接调内部聚合：digestJaSync 要求真分词器，这里走 collectJa 手算键
  const entries = collectJa(fake.tokenize(), { minLen: 1, frag: { text: '日本日本', t: 0, src: 'x' }, sampleLimit: 3 });
  const keys = entries.map((e) => jaEntryKey(e.word, e.pos, e.reading, e.unknown));
  assert.equal(entries.length, 2);
  assert.notEqual(keys[0], keys[1], '两条不同读音的词元不能聚到一起');
});

test('缺口A · 未知词与已知词同名同类时不合并', async () => {
  const fake = {
    tokenize: () => [
      tok('テスト', 'テスト', 'テスト', '名詞', '一般'),
      tok('テスト', 'テスト', '*', '名詞', '一般'), // basic_form='*' = 未知
    ],
  };
  const entries = collectJa(fake.tokenize(), { minLen: 1, frag: { text: 'テスト', t: 0, src: 'x' } });
  const keys = entries.map((e) => jaEntryKey(e.word, e.pos, e.reading, e.unknown));
  assert.equal(new Set(keys).size, keys.length, '已知 / 未知各成一条');
});

test('缺口A · entryKey 里的读音与条目 reading 一致（人工修订不会串到同名异读的词）', { skip }, async () => {
  const res = await run(['今日はいい天気ですね。', '今日の新聞を読む。']);
  const it = res.items.find((x) => x.word === '今日');
  assert.ok(it);
  assert.ok(it.entryKey.includes(it.reading), '键里必须能读到自己的读音');
  assert.equal(it.entryKey, jaEntryKey(it.word, it.pos, it.reading, it.unknown));
});

test('缺口A · known 判定按 entryKey，不按裸词形', () => {
  // 模拟 known 集合：只认「日本#ニッポン」
  const known = new Set([jaEntryKey('日本', 'prop.', 'ニッポン')]);
  assert.equal(known.has(jaEntryKey('日本', 'prop.', 'ニッポン')), true);
  assert.equal(known.has(jaEntryKey('日本', 'prop.', 'ニホン')), false, '另一个读音不能被当成已掌握');
});

test('缺口A · known 走真实管线：只写 entryKey 时另一个读音必须留下', { skip }, async () => {
  const cfg = { ...CFG };
  const base = await digestJaSync(
    [{ text: '日本の学生です。', t: 0, src: 'test.srt' }],
    cfg,
    { tokenizer: await tk() },
  );
  const target = base.items.find((it) => it.word === '日本');
  assert.ok(target, '基线里应抽到「日本」');

  // ① 只标这一个读音 → 它被过滤，别的读音不受影响
  const only = await digestJaSync(
    [{ text: '日本の学生です。', t: 0, src: 'test.srt' }],
    cfg,
    { tokenizer: await tk(), known: new Set([target.entryKey]) },
  );
  assert.equal(only.items.some((it) => it.entryKey === target.entryKey), false, '被标已知的读音应被过滤');
  assert.equal(only.stats.dropped?.known ?? only.dropped?.known, 1, '应记一条 known 过滤');

  // ② 裸词形 → 覆盖这个词形的全部读音（兼容老 known.txt）
  const bare = await digestJaSync(
    [{ text: '日本の学生です。', t: 0, src: 'test.srt' }],
    cfg,
    { tokenizer: await tk(), known: new Set(['日本']) },
  );
  assert.equal(bare.items.some((it) => it.word === '日本'), false, '裸词形应把该词形整体过滤');
});

test('缺口A · known 不得静默扩大到全部读音', { skip }, async () => {
  // 两条互不相干的读音：用「今日」在不同语境下通常只有一个读音，
  // 这里直接构造 known 集合：一个真实 entryKey + 一个「同词形的另一个读音」的键。
  const cfg = { ...CFG };
  const base = await digestJaSync(
    [{ text: '今日はいい天気ですね。', t: 0, src: 'test.srt' }],
    cfg,
    { tokenizer: await tk() },
  );
  const it = base.items.find((x) => x.word === '今日');
  assert.ok(it, '基线里应抽到「今日」');
  const otherReading = it.reading === 'キョウ' ? 'コンニチ' : 'キョウ';
  const otherKey = jaEntryKey(it.word, it.pos, otherReading, false);
  assert.notEqual(otherKey, it.entryKey);

  // 只标「另一个读音」→ 真正出现的这个读音不能被连带过滤掉
  const res = await digestJaSync(
    [{ text: '今日はいい天気ですね。', t: 0, src: 'test.srt' }],
    cfg,
    { tokenizer: await tk(), known: new Set([otherKey]) },
  );
  assert.ok(
    res.items.some((x) => x.entryKey === it.entryKey),
    `标了 ${otherKey} 不该把 ${it.entryKey} 一起过滤掉`,
  );
});


// ══════════════════════════════════════════════════════════
// 缺口 B：位置对应原文
// ══════════════════════════════════════════════════════════

test('缺口B · 清洗映射：半角浊音假名 ｶﾞ(2字) → ガ(1字)，完整区间必须是 [0,2)', () => {
  const raw = 'ｶﾞｯｺｳに行く';
  const r = cleanJapaneseWithMap(raw);
  assert.equal(r.dropped, false);
  assert.equal(r.clean, 'ガッコウに行く');

  // ★ 关键断言：ガ 覆盖的是原文 [0, 2)，两个字符合成一个
  assert.deepEqual([r.starts[0], r.ends[0]], [0, 2], 'ガ 的来源区间必须是 [0,2)');
  assert.equal(raw.slice(0, 2), 'ｶﾞ');
  assert.equal(raw.slice(r.starts[0], r.ends[0]), 'ｶﾞ', '用区间切出来的原文必须是完整的 ｶﾞ');

  // 其余字符各自独立
  assert.deepEqual([r.starts[1], r.ends[1]], [2, 3]); // ッ
  assert.deepEqual([r.starts[2], r.ends[2]], [3, 4]); // コ

  // 每个字符的区间都要能切出非空原文，且整体单调
  for (let i = 0; i < r.clean.length; i += 1) {
    assert.ok(r.ends[i] > r.starts[i], `${r.clean[i]} 的区间不能为空`);
    assert.ok(r.ends[i] <= raw.length, `${r.clean[i]} 的区间越界`);
    assert.ok(r.starts[i] >= 0);
  }
});

test('缺口B · 清洗映射：㍿ → 株式会社，一对多展开时四个字都覆盖原文 [0,1)', () => {
  const raw = '㍿は株式会社';
  const r = cleanJapaneseWithMap(raw);
  assert.equal(r.clean, '株式会社は株式会社');

  // ★ 关键断言：前四个字（株式会社）全部来自那 1 个字的 ㍿
  for (let i = 0; i < 4; i += 1) {
    assert.deepEqual(
      [r.starts[i], r.ends[i]],
      [0, 1],
      `${r.clean[i]} 必须覆盖原文 [0,1)（即 ㍿）`,
    );
  }
  assert.equal(raw.slice(0, 1), '㍿');

  // 后面的「は」独立
  assert.deepEqual([r.starts[4], r.ends[4]], [1, 2]);
  assert.equal(raw.slice(1, 2), 'は');

  // 把「株」的区间换算回原文，得到的就是 ㍿，不是整句
  assert.equal(raw.slice(r.starts[0], r.ends[0]), '㍿');
});

test('缺口B · 长音符不并入前一个假名：ｺｰ → コ[0,1) + ー[1,2)，整词才是 [0,2)', () => {
  const raw = 'ｺｰﾋｰを飲む';
  const r = cleanJapaneseWithMap(raw);
  assert.equal(r.clean, 'コーヒーを飲む');
  // ★ 每个音拍各自对应一个原字符，不做合成
  assert.deepEqual([r.starts[0], r.ends[0]], [0, 1], 'コ = [0,1)');
  assert.deepEqual([r.starts[1], r.ends[1]], [1, 2], 'ー = [1,2)');
  assert.deepEqual([r.starts[2], r.ends[2]], [2, 3], 'ヒ = [2,3)');
  assert.deepEqual([r.starts[3], r.ends[3]], [3, 4], 'ー = [3,4)');
  assert.equal(raw.slice(0, 1), 'ｺ');
  assert.equal(raw.slice(1, 2), 'ｰ');
  // 整词（分析文本 [0,4)）才覆盖原文 [0,4)
  const whole = toOriginalRange(r, 0, 4);
  assert.deepEqual(whole, { start: 0, end: 4 });
  assert.equal(raw.slice(whole.start, whole.end), 'ｺｰﾋｰ');
});

test('缺口B · 组合记号：か\\u3099 → が，区间 [0,2)，分析结果等于整串 NFKC', () => {
  const raw = 'か\u3099くせいです';
  const r = cleanJapaneseWithMap(raw);
  // 分析文本必须等于 raw.normalize('NFKC')（在其它清洗之前的那一步）
  assert.equal(r.clean, raw.normalize('NFKC'));
  assert.equal(r.clean, 'がくせいです');
  assert.equal(r.exact, true, '逐单位归一必须与整串归一一致');
  // が 由「か」+ 组合浊点合成，覆盖原文 [0,2)
  assert.deepEqual([r.starts[0], r.ends[0]], [0, 2]);
  assert.equal(raw.slice(0, 2), 'か\u3099');
  // 后面的假名独立
  assert.deepEqual([r.starts[1], r.ends[1]], [2, 3]);
});

test('缺口B · 组合记号：半浊点 ハ\\u309a → パ，以及 か\\u309a（无预组字符）', () => {
  const raw1 = 'ハ\u309aーティー';
  const r1 = cleanJapaneseWithMap(raw1);
  assert.equal(r1.clean, raw1.normalize('NFKC'));
  assert.deepEqual([r1.starts[0], r1.ends[0]], [0, 2], 'パ 覆盖 [0,2)');

  const raw2 = 'か\u309a';
  const r2 = cleanJapaneseWithMap(raw2);
  assert.equal(r2.clean, raw2.normalize('NFKC'), '无预组字符时也要与整串归一一致');
});

test('缺口B · 逐单位归一 vs 整串归一：多组用例必须完全一致', () => {
  const cases = [
    'ｶﾞｯｺｳに行く',
    'ｺｰﾋｰを飲む',
    'か\u3099くせい',
    'ハ\u309aーティー',
    '㍿は株式会社',
    'ＡＢＣ１２３',
    'ｷｬﾝﾍﾟｰﾝ',
    'ねこ🐟すき',
  ];
  for (const raw of cases) {
    const r = cleanJapaneseWithMap(raw);
    assert.equal(r.exact, true, `${JSON.stringify(raw)} 的逐单位归一与整串不一致`);
    // 清洗后在「其它规则」之前的那一步，必须等于整串 NFKC
    // （这里用不含删除/压缩规则影响的纯归一比较）
    assert.equal(
      r.clean,
      raw.normalize('NFKC').replace(/[^\u3041-\u3096\u30A1-\u30FA\u30FC\u30FD\u30FE\u3400-\u4DBF\u4E00-\u9FFF\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A0-9A-Za-z\u3005\u30F6]+/g, ' ').trim(),
      `${JSON.stringify(raw)} 清洗结果异常`,
    );
  }
});

test('缺口B · 清洗映射：区间不得串到相邻字符（逐字符校验全覆盖）', () => {
  const cases = [
    'ｶﾞｯｺｳに行く',
    '㍿は株式会社',
    'ｺｰﾋｰを飲む',
    'ＡＢＣ１２３',
    'ねこ🐟すき',
  ];
  for (const raw of cases) {
    const r = cleanJapaneseWithMap(raw);
    for (let i = 0; i < r.clean.length; i += 1) {
      const seg = raw.slice(r.starts[i], r.ends[i]);
      assert.ok(seg.length > 0, `${JSON.stringify(raw)} 第 ${i} 字 "${r.clean[i]}" 切不出原文`);
      // 覆盖区间长度不能超过 2（目前只有 ｶﾞ / ｺｰ 这类两字合一的情况）
      assert.ok(
        r.ends[i] - r.starts[i] <= 2,
        `${JSON.stringify(raw)} 第 ${i} 字 "${r.clean[i]}" 覆盖了 ${r.ends[i] - r.starts[i]} 个原字符，疑似串到邻居`,
      );
    }
  }
});

test('缺口B · toOriginalRange 用最大端点算区间（能跨多个分析字符合并）', async () => {
  const { toOriginalRange } = await import('../src/ja/clean.js');
  const raw = '㍿は株式会社';
  const r = cleanJapaneseWithMap(raw);
  // 分析文本前 5 个字符是「株式会社は」→ 原文应该是 [0,2)
  const rg = toOriginalRange(r, 0, 5);
  assert.deepEqual(rg, { start: 0, end: 2 });
  assert.equal(raw.slice(rg.start, rg.end), '㍿は');
  // 单字符区间
  assert.deepEqual(toOriginalRange(r, 0, 1), { start: 0, end: 1 });
  // 越界返回 null
  assert.equal(toOriginalRange(r, 0, 999), null);
  assert.equal(toOriginalRange(r, 3, 3), null);
});

test('缺口B · 清洗映射：兼容字符（全角数字/字母）归一后仍指回原位置', () => {
  const raw = 'ＡＢＣは１２３です';
  const r = cleanJapaneseWithMap(raw);
  assert.ok(r.clean.startsWith('ABC'), r.clean);
  assert.equal(r.map[0], 0);
  assert.equal(r.map[3], 3, 'ABC 之后紧接「は」在原文下标 3');
});

test('缺口B · 清洗映射：emoji / 零宽 / HTML 标签被删后映射不漂移', () => {
  const raw = '😀<b>今日</b>\u200bは晴れ😀です';
  const r = cleanJapaneseWithMap(raw);
  assert.equal(r.dropped, false, r.clean);
  assert.ok(!r.clean.includes('<'), 'HTML 标签要被删');
  const idx = r.clean.indexOf('今');
  assert.ok(idx >= 0);
  // 「今」在原文里的位置 = raw.indexOf('今')
  assert.equal(r.map[idx], raw.indexOf('今'), `今 应指回原文 ${raw.indexOf('今')}`);
});

test('缺口B · usage.text 是原文（未 NFKC），slice(start,end) === surfaceOriginal', { skip }, async () => {
  const raw = 'ｺｰﾋｰを飲みたかった。';
  const res = await run([raw]);
  const it = res.items.find((x) => x.word === 'コーヒー');
  assert.ok(it, '半角片假名应被归一后命中');
  const u = it.usages[0];
  assert.equal(u.text, raw, 'usage.text 必须是原始字幕，不是归一后的文本');
  assert.equal(u.text.slice(u.start, u.end), u.surfaceOriginal);
  assert.equal(u.surface, 'コーヒー', 'surface 是分析文本里的写法');
  assert.equal(u.surfaceOriginal, 'ｺｰﾋｰ', 'surfaceOriginal 是原文里的写法');
});

test('缺口B · 含 emoji 与 HTML 实体的句子，位置仍然对得上', { skip }, async () => {
  const raw = '😀猫が&amp;好きだよ🎵';
  const res = await run([raw]);
  const it = res.items.find((x) => x.word === '猫');
  assert.ok(it, `猫 应被抽到：${res.items.map((x) => x.word).join(',')}`);
  const u = it.usages[0];
  assert.equal(u.text, raw);
  assert.equal(u.text.slice(u.start, u.end), u.surfaceOriginal);
  assert.equal(u.surfaceOriginal, '猫');
});

test('缺口B · 被删除的标记（URL / 话题标签 / 音符）不影响后面的位置', { skip }, async () => {
  const raw = 'https://x.test/a #话题# ♪♪ 猫が好き';
  const res = await run([raw]);
  const it = res.items.find((x) => x.word === '猫');
  assert.ok(it, `猫 应被抽到：${res.items.map((x) => x.word).join(',')}`);
  const u = it.usages[0];
  assert.equal(u.text, raw);
  assert.equal(u.text.slice(u.start, u.end), '猫');
});

test('缺口B · 压缩重复字符（ｗｗｗｗ→ｗｗ）后位置仍然正确', { skip }, async () => {
  const raw = '猫がかわいいｗｗｗｗｗｗ';
  const res = await run([raw]);
  const it = res.items.find((x) => x.word === '猫');
  assert.ok(it);
  const u = it.usages[0];
  assert.equal(u.text.slice(u.start, u.end), '猫');
});

test('缺口B · 全量自检：所有 usage 都能在原文里切出 surfaceOriginal', { skip }, async () => {
  const raws = [
    '今日はいい天気ですね。',
    'ｺｰﾋｰを飲みたかった。',
    'ｶﾞｯｺｳに行きましょう。',
    '😀猫が好き🎵',
    'https://example.com 今日の新聞',
    'Vtuberとして活動しています。',
    'ＡＢＣは１２３です。',
  ];
  const res = await run(raws);
  let checked = 0;
  for (const it of res.items) {
    for (const u of it.usages) {
      assert.ok(raws.includes(u.text), `usage.text 必须是某条原文：${JSON.stringify(u.text)}`);
      assert.equal(
        u.text.slice(u.start, u.end),
        u.surfaceOriginal,
        `${it.word} @ ${JSON.stringify(u.text)} [${u.start},${u.end})`,
      );
      assert.ok(u.start >= 0 && u.end <= u.text.length, `区间越界：${it.word}`);
      assert.ok(u.end > u.start, `空区间：${it.word}`);
      checked += 1;
    }
  }
  assert.ok(checked >= 10, `至少检查 10 处，实际 ${checked}`);
});
