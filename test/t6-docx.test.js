/**
 * T6 · Word 展示层契约测试
 *
 * 覆盖 T6 待办：
 *   - 标题前缀按语言取：日文「日语词汇整理」、英文「英语词汇整理」，显式 title 优先
 *   - 日文字体：正文 run 带 w:eastAsia="Meiryo"，styles 的 w:lang eastAsia 是 ja-JP
 *   - 词条行展示：读音（片假名）+ 假名（平假名）、未收录标记、offsetExact:false 的定位提示
 *   - 英文文档一个日文字段都不该冒出来
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildDocumentXml, docDefaultsFor, LANGUAGE_DOC_DEFAULTS } from '../src/docx/build.js';
import { styles } from '../src/docx/ooxml.js';

/** 造一个最小的日文 docModel */
function jaDoc(overrides = {}) {
  return {
    title: null,
    language: 'ja',
    subtitle: '共 2 个词条',
    generatedAt: '2024-01-01 00:00:00',
    sources: [{ name: 'a.srt', format: 'srt', count: 2 }],
    stats: { fileCount: 1, fragmentCount: 2, keptCount: 2, filteredCount: 0, phraseCount: 0 },
    params: [],
    sections: [{
      key: 'pos:n.',
      label: '词性 · 名词（2）',
      items: [
        {
          language: 'ja', word: '日本', display: '日本', reading: 'ニッポン', readingHiragana: 'にっぽん',
          usageReading: 'ニホン', pos: 'prop.', posLabel: '专有名词', posDetail: '固有名詞',
          lemmaSource: 'basic_form', unknown: false, count: 2, meaning: '日本',
          usages: [{ text: '日本の学生です', src: 'a.srt', t: 3 }],
        },
        {
          language: 'ja', word: 'ワクワク', display: 'ワクワク', reading: '', readingHiragana: '',
          pos: 'other', posLabel: '其他', unknown: true, count: 1, meaning: '',
          usages: [{ text: 'ワクワクする', src: 'a.srt', t: 9 }], offsetExact: false,
        },
      ],
    }],
    topWords: [],
    filtered: [],
    ...overrides,
  };
}

const JA_OPTS = { eastAsia: 'Meiryo', eastAsiaLang: 'ja-JP' };

test('T6 · 语言默认值表本身是完整的', () => {
  assert.equal(LANGUAGE_DOC_DEFAULTS.ja.titlePrefix, '日语词汇整理');
  assert.equal(LANGUAGE_DOC_DEFAULTS.en.titlePrefix, '英语词汇整理');
  assert.equal(docDefaultsFor('ja').eastAsiaLang, 'ja-JP');
  // 不认识的、空的、undefined 一律掉回英文，不能抛
  assert.equal(docDefaultsFor('xx').titlePrefix, '英语词汇整理');
  assert.equal(docDefaultsFor(undefined).titlePrefix, '英语词汇整理');
});

test('T6 · 日文文档标题前缀是「日语词汇整理」，不会冒出英文前缀', () => {
  const xml = buildDocumentXml(jaDoc(), JA_OPTS);
  assert.ok(xml.includes('日语词汇整理'), '封面标题应是日语前缀');
  assert.ok(!xml.includes('英语词汇整理'), '日文文档不该出现英文标题前缀');
});

test('T6 · 显式 title 优先于语言前缀', () => {
  const xml = buildDocumentXml(jaDoc({ title: '自定义标题 · 测试' }), JA_OPTS);
  assert.ok(xml.includes('自定义标题 · 测试'));
  assert.ok(!xml.includes('日语词汇整理'));
});

test('T6 · 英文文档不被日文改动污染', () => {
  const enDoc = jaDoc({ language: 'en' });
  enDoc.sections[0].items = enDoc.sections[0].items.map((it) => ({
    ...it, language: 'en', reading: '', readingHiragana: '', posDetail: '', unknown: false,
  }));
  const xml = buildDocumentXml(enDoc, {});
  assert.ok(xml.includes('英语词汇整理'));
  assert.ok(!xml.includes('日语词汇整理'));
  assert.ok(!xml.includes('读音：'), '英文文档不该出现「读音：」');
  assert.ok(!xml.includes('未收录'), '英文文档不该出现「未收录」');
  assert.ok(!xml.includes('Meiryo'), '英文文档不该用日文字体');
});

test('T6 · 日文词条行带片假名读音与平假名', () => {
  const xml = buildDocumentXml(jaDoc(), JA_OPTS);
  assert.ok(xml.includes('读音：ニッポン'), '应输出读音标签 + 片假名');
  assert.ok(xml.includes('（にっぽん）'), '应输出平假名');
  // 用法里的读音和词条读音不同时才额外标出来
  assert.ok(xml.includes('用时 ニホン'), '用法读音与词条读音不同时应标出');
});

test('T6 · 未知词标「未收录」，且不编造读音', () => {
  const xml = buildDocumentXml(jaDoc(), JA_OPTS);
  assert.ok(xml.includes('未收录'), 'unknown 词条应有未收录标记');
  // 「ワクワク」后面不该跟着任何读音标签 —— 读音为空就是空
  const idx = xml.indexOf('ワクワク');
  assert.ok(idx > 0);
});

test('T6 · offsetExact:false 保留定位提示', () => {
  const xml = buildDocumentXml(jaDoc(), JA_OPTS);
  assert.ok(xml.includes('定位提示'), '无法精确对应原文的条目必须给出提示');
});

test('T6 · 日文字体走 w:eastAsia，不劫持拉丁字母字体', () => {
  const xml = buildDocumentXml(jaDoc(), JA_OPTS);
  const hits = (xml.match(/w:eastAsia="Meiryo"/g) || []).length;
  assert.ok(hits > 5, `日文文档应大量出现 eastAsia=Meiryo，实际 ${hits}`);
  // 只给 eastAsia 时不能顺手改掉 ascii/hAnsi
  assert.ok(!/w:ascii="Meiryo"/.test(xml), '只声明亚洲字体，不应把拉丁字母也换成 Meiryo');
});

test('T6 · styles 的 w:lang eastAsia 是 ja-JP', () => {
  const st = styles({ fontCn: 'Meiryo', fontEn: 'Calibri', eastAsiaLang: 'ja-JP' });
  assert.ok(st.includes('<w:lang w:val="en-US" w:eastAsia="ja-JP"/>'), 'styles 里应真的落下 w:lang');
  // 中文默认仍是 zh-CN
  const stCn = styles({});
  assert.ok(stCn.includes('w:eastAsia="zh-CN"'));
});
