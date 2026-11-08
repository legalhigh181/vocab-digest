import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DIFFICULTY_LABELS, FREQ_BAND_LABELS, TAG_DIMENSIONS, difficultyTag, filterItemsForTest,
  freqBand, groupByTag, tagsOf,
} from './_tags-shim.js';

const ITEMS = [
  { word: 'gradient', display: 'gradient', count: 9, pos: 'n.', base: false, sources: { 'a.srt': 9 } },
  { word: 'the', display: 'The', count: 15, pos: 'other', base: false, sources: { 'a.srt': 15, 'b.xml': 2 } },
  { word: 'train', display: 'train', count: 4, pos: 'n.', base: true, sources: { 'a.srt': 4 } },
  { word: 'once', display: 'once', count: 1, pos: 'adv.', base: true, sources: { 'b.xml': 1 } },
];

test('难度标签：基础词 / 进阶词 / 未标注', () => {
  assert.equal(difficultyTag(ITEMS[0]), 'advanced');
  assert.equal(difficultyTag(ITEMS[1]), 'unknown');
  assert.equal(difficultyTag(ITEMS[2]), 'basic');
  assert.equal(DIFFICULTY_LABELS.basic, '基础词');
});

test('频次档：1 次 / 2-4 次 / ≥5 次', () => {
  assert.equal(freqBand(1), 'once');
  assert.equal(freqBand(4), 'several');
  assert.equal(freqBand(5), 'often');
  assert.equal(FREQ_BAND_LABELS.often, '高频（≥5 次）');
});

test('tagSummary 的四个维度都出现', () => {
  assert.deepEqual([...TAG_DIMENSIONS], ['pos', 'difficulty', 'source', 'freq']);
  const t = tagsOf(ITEMS[1]);
  assert.deepEqual(t.source.sort(), ['a.srt', 'b.xml']);
  assert.equal(t.freq, 'often');
});

test('按维度分章：词性 / 难度 / 来源 / 频次', () => {
  const byPos = groupByTag(ITEMS, 'pos');
  assert.deepEqual(byPos.map((g) => g.tagKey), ['n.', 'adv.', 'other']);
  const byDiff = groupByTag(ITEMS, 'difficulty');
  assert.deepEqual(byDiff.map((g) => g.tagKey), ['basic', 'advanced', 'unknown']);
  const byFreq = groupByTag(ITEMS, 'freq');
  assert.deepEqual(byFreq.map((g) => g.tagKey), ['often', 'several', 'once']);
  // 来源维度：一个词出现在多个来源章节里（并列而非互斥）
  const bySrc = groupByTag(ITEMS, 'source');
  assert.equal(bySrc.find((g) => g.tagKey === 'a.srt').items.length, 3);
  assert.equal(bySrc.find((g) => g.tagKey === 'b.xml').items.length, 2);
});

test('按标签过滤：tag=维度:值 与分字段等价', () => {
  assert.equal(filterItemsForTest(ITEMS, { tag: 'difficulty:basic' }).length, 2);
  assert.equal(filterItemsForTest(ITEMS, { difficulty: 'basic' }).length, 2);
  assert.equal(filterItemsForTest(ITEMS, { tag: 'pos:n.' }).length, 2);
  assert.equal(filterItemsForTest(ITEMS, { tag: 'source:b.xml' }).length, 2);
  assert.equal(filterItemsForTest(ITEMS, { tag: 'freq:once' }).length, 1);
  assert.equal(filterItemsForTest(ITEMS, { tag: 'bogus:x' }).length, ITEMS.length);
});
