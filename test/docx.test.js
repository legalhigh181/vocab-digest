import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDocumentXml } from '../src/docx/build.js';
import { renderDocx } from '../src/docx/write.js';
import { makeZip, readZip } from '../src/docx/zip.js';
import { checkXml, documentStats, verifyRun } from '../src/verify.js';
import { escapeXml } from '../src/docx/ooxml.js';

const model = {
  title: '英语词汇整理 · 测试',
  subtitle: '共 2 个词条',
  generatedAt: '2024-01-01 00:00:00',
  sources: [{ name: 'a.xml', format: 'xml', count: 2 }],
  stats: { fileCount: 1, fragmentCount: 2, keptCount: 2, filteredCount: 0, phraseCount: 0 },
  params: [{ key: '最低词长', value: 3 }],
  sections: [
    {
      key: 'n.',
      label: '词性 · 名词（1）',
      items: [{
        display: 'model', word: 'model', count: 2, pos: 'n.', posLabel: '名词', meaning: '模型',
        samples: [{ text: 'the model works', src: 'a.xml', t: 12 }], firstT: 12,
        sources: { 'a.xml': 2 }, base: false, forms: { models: 1 },
      }],
    },
    {
      key: 'v.',
      label: '词性 · 动词（1）',
      items: [{
        display: 'train', word: 'train', count: 1, pos: 'v.', posLabel: '动词', meaning: '',
        samples: [], firstT: undefined, sources: { 'a.xml': 1 }, base: true, forms: {},
      }],
    },
  ],
  topWords: [{ word: 'model', display: 'model', count: 2, posLabel: '名词' }],
  filtered: [{ word: 'the', count: 9, reason: '已知词' }],
};

test('xml 转义：& < > " 与非法控制字符', () => {
  assert.equal(escapeXml('a&b<c>"d"'), 'a&amp;b&lt;c&gt;&quot;d&quot;');
  assert.equal(escapeXml('a\u0000b'), 'ab');
});

test('buildDocumentXml：含封面、统计表、两个章节、附录', () => {
  const xml = buildDocumentXml(model);
  assert.ok(xml.startsWith('<?xml'));
  assert.ok(xml.includes('英语词汇整理 · 测试'));
  assert.ok(xml.includes('词性 · 名词（1）'));
  assert.ok(xml.includes('词性 · 动词（1）'));
  assert.ok(xml.includes('附录 A · 词频总表'));
  assert.ok(xml.includes('附录 B · 被过滤的词'));
  assert.ok(xml.includes('“the model works”'));
  assert.ok(xml.includes('TOC \\o'));
  assert.equal(checkXml(xml).ok, true);
});

test('确定性：同模型两次渲染逐字节一致', () => {
  const a = buildDocumentXml(model);
  const b = buildDocumentXml(model);
  assert.equal(a, b);
  const z1 = renderDocx(model).zip;
  const z2 = renderDocx(model).zip;
  assert.ok(z1.equals(z2), 'zip 也应字节一致');
});

test('toc:false 时不写目录域', () => {
  const xml = buildDocumentXml(model, { toc: false });
  assert.ok(!xml.includes('TOC \\o'));
});

test('zip：写入后读回内容一致，CRC 被校验', () => {
  const entries = [{ name: 'a.txt', data: 'hello world '.repeat(20) }, { name: 'b/c.xml', data: '<x/>' }];
  const buf = makeZip(entries, { date: new Date(Date.UTC(2020, 0, 1)) });
  const back = readZip(buf);
  assert.equal(back.get('a.txt').toString(), entries[0].data);
  assert.equal(back.get('b/c.xml').toString(), '<x/>');
  const broken = Buffer.from(buf);
  // 破坏第一个条目内容的一个字节 → CRC 不符
  broken[30 + 'a.txt'.length] ^= 0xff;
  assert.throws(() => readZip(broken), /CRC|size|corrupted/);
});

test('verifyRun：全部检查通过', () => {
  const { documentXml, zip, links } = renderDocx(model);
  // links 必须一起传：document.xml 里的 rId 来自这张表，重渲染要复用它才能逐字节一致
  const r = verifyRun({ documentXml, zipBuf: zip, docModel: model, opts: { links } });
  assert.equal(r.ok, true, r.checks.filter((c) => c.status === 'fail').map((c) => `${c.id}: ${c.message}`).join('; '));
  assert.equal(r.stats.heading1 >= 2, true);
});

test('verifyRun：篡改正文会被 determinism 抓到', () => {
  const { documentXml, zip } = renderDocx(model);
  const tampered = documentXml.replace('neural', 'xxx').replace('模型', '模型X');
  const r = verifyRun({ documentXml: tampered, zipBuf: zip, docModel: model });
  assert.equal(r.ok, false);
  assert.ok(r.checks.some((c) => c.id === 'zip/document-match' && c.status === 'fail'));
});

test('checkXml：抓裸 & 与不配对标签', () => {
  assert.equal(checkXml('<a><b/></a>').ok, true);
  assert.equal(checkXml('<a>&x</a>').ok, false);
  assert.equal(checkXml('<a><b></a>').ok, false);
});

test('documentStats：统计结构', () => {
  const s = documentStats(buildDocumentXml(model));
  assert.equal(s.tables >= 3, true);
  assert.equal(s.entries, 2);
});
