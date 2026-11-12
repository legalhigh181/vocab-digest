/**
 * 映射的「手写预期区间」验收：不依赖实现自己算，而是人肉把预期写死。
 *
 * 用户指出：`slice===surfaceOriginal` 若两者都由同一映射生成，只能证明内部一致，
 * 不能证明定位准确。所以这里**逐字手写预期 [start, end)**，与实现输出对比。
 *
 * 每个用例的注释里给出原文的逐字符下标，便于人工复核。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanJapaneseWithMap, toOriginalRange } from '../src/ja/clean.js';

/**
 * 断言每个分析字符的覆盖区间等于手写预期。
 * @param {string} raw 原文
 * @param {Array<[string, number, number]>} expected [分析字符, 预期起点, 预期终点]
 */
function expectRanges(raw, expected) {
  const r = cleanJapaneseWithMap(raw);
  assert.equal(r.exact, true, '逐单位归一必须与整串一致');
  const actual = [];
  for (let i = 0; i < r.clean.length; i += 1) {
    actual.push([r.clean[i], r.starts[i], r.ends[i]]);
  }
  assert.deepEqual(actual, expected, `原文 ${JSON.stringify(raw)}`);
  // 每个手写区间在原文里切出来的必须非空
  for (const [, s, e] of expected) {
    assert.ok(raw.slice(s, e).length > 0, `区间 [${s},${e}) 切不出内容`);
  }
}

test('手写区间 · ｶﾞｯｺｳに行く', () => {
  // 下标:  0    1    2    3    4    5    6    7
  // 字符:  ｶ    ﾞ    ｯ    ｺ    ｳ    に   行   く
  // 注意：UTF-16 下标按「码位」数，半角片假名都是 1 个单元
  const raw = 'ｶﾞｯｺｳに行く';
  expectRanges(raw, [
    ['ガ', 0, 2], // ｶ + ﾞ 合成
    ['ッ', 2, 3],
    ['コ', 3, 4],
    ['ウ', 4, 5],
    ['に', 5, 6],
    ['行', 6, 7],
    ['く', 7, 8],
  ]);
  assert.equal(raw.length, 8);
});

test('手写区间 · ｺｰﾋｰを飲む（长音符独立成拍）', () => {
  // 下标:  0    1    2    3    4    5    6
  // 字符:  ｺ    ｰ    ﾋ    ｰ    を    飲    む
  const raw = 'ｺｰﾋｰを飲む';
  expectRanges(raw, [
    ['コ', 0, 1],
    ['ー', 1, 2],
    ['ヒ', 2, 3],
    ['ー', 3, 4],
    ['を', 4, 5],
    ['飲', 5, 6],
    ['む', 6, 7],
  ]);
  assert.equal(raw.length, 7);
});

test('手写区间 · か\\u3099くせい（组合浊点）', () => {
  // 下标:  0    1    2    3    4
  // 字符:  か   ゙    く    せ    い
  const raw = 'か\u3099くせい';
  expectRanges(raw, [
    ['が', 0, 2], // か + 组合浊点
    ['く', 2, 3],
    ['せ', 3, 4],
    ['い', 4, 5],
  ]);
  assert.equal(raw.length, 5);
});

test('手写区间 · ㍿は株式会社（一对多展开）', () => {
  // 下标:  0    1    2    3    4    5
  // 字符:  ㍿  は   株   式   会   社
  const raw = '㍿は株式会社';
  expectRanges(raw, [
    ['株', 0, 1],
    ['式', 0, 1],
    ['会', 0, 1],
    ['社', 0, 1],
    ['は', 1, 2],
    ['株', 2, 3],
    ['式', 3, 4],
    ['会', 4, 5],
    ['社', 5, 6],
  ]);
  assert.equal(raw.length, 6);
});

test('手写区间 · 全角字母数字逐字对应', () => {
  const raw = 'ＡＢＣ１２３';
  expectRanges(raw, [
    ['A', 0, 1],
    ['B', 1, 2],
    ['C', 2, 3],
    ['1', 3, 4],
    ['2', 4, 5],
    ['3', 5, 6],
  ]);
});

test('手写区间 · 删除规则之后的下标仍准确', () => {
  // 原文:  "😀😀今日 は"
  // 下标(UTF-16): 😀=0,1  😀=2,3  今=4  日=5  空格=6  は=7
  const raw = '😀😀今日 は';
  const r = cleanJapaneseWithMap(raw);
  // emoji 被白名单变成空格合并，但「今日 は」的位置必须指回 4 之后
  const idx = r.clean.indexOf('今');
  assert.ok(idx >= 0, r.clean);
  assert.equal(r.starts[idx], raw.indexOf('今'));
  assert.equal(raw.slice(r.starts[idx], r.ends[idx]), '今');
});

test('手写区间 · 区间换算：整词范围 = 各字范围的并集', () => {
  const raw = 'ｺｰﾋｰを飲む';
  const r = cleanJapaneseWithMap(raw);
  // 「コーヒー」= 分析文本 [0,4)
  assert.deepEqual(toOriginalRange(r, 0, 4), { start: 0, end: 4 });
  // 「ヒー」= 分析文本 [2,4)
  assert.deepEqual(toOriginalRange(r, 2, 4), { start: 2, end: 4 });
  // 「を」= 分析文本 [4,5)
  assert.deepEqual(toOriginalRange(r, 4, 5), { start: 4, end: 5 });
  assert.equal(raw.slice(0, 4), 'ｺｰﾋｰ');
  assert.equal(raw.slice(2, 4), 'ﾋｰ');
});

test('手写区间 · 逐个字符覆盖不重叠且连续（无跳跃、无重叠）', () => {
  const cases = ['ｶﾞｯｺｳに行く', 'ｺｰﾋｰを飲む', 'か\u3099くせい', 'ＡＢＣ１２３'];
  for (const raw of cases) {
    const r = cleanJapaneseWithMap(raw);
    let prevEnd = 0;
    for (let i = 0; i < r.clean.length; i += 1) {
      // 起点不能小于上一个的终点（不允许回溯到已覆盖的原文）
      assert.ok(
        r.starts[i] >= prevEnd,
        `${JSON.stringify(raw)} 第 ${i} 字 "${r.clean[i]}" 起点 ${r.starts[i]} 早于上一终点 ${prevEnd}`,
      );
      prevEnd = r.ends[i];
    }
  }
});
