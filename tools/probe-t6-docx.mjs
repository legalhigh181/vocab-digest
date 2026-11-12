// 探针：日文文档模型的渲染结果（标题/读音/假名/未收录/eastAsia）
import { buildDocumentXml } from '../src/docx/build.js';
import { styles } from '../src/docx/ooxml.js';

const doc = {
  title: '日语词汇整理 · 测试',
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
        language: 'ja', word: '日本', display: '日本', reading: 'ニホン', readingHiragana: 'にほん',
        usageReading: 'ニッポン', pos: 'prop.', posLabel: '专有名词', posDetail: '固有名詞',
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
  topWords: [], filtered: [],
};

const xml = buildDocumentXml(doc, { eastAsia: 'Meiryo', eastAsiaLang: 'ja-JP' });
const probes = {
  title: xml.includes('日语词汇整理'),
  noEnTitle: !xml.includes('英语词汇整理'),
  reading: xml.includes('读音：ニホン'),
  hira: xml.includes('（にほん）'),
  usageReading: xml.includes('用时 ニッポン'),
  unknown: xml.includes('未收录'),
  eastAsiaFont: xml.includes('w:eastAsia="Meiryo"'),
  posDetail: xml.includes('词性细分：固有名詞'),
  offsetNote: xml.includes('定位提示'),
  enUntouched: !xml.includes('音标'),
};
console.log(JSON.stringify(probes, null, 1));
const st = styles({ fontCn: 'Meiryo', fontEn: 'Calibri', eastAsiaLang: 'ja-JP' });
console.log('styles lang ja-JP:', st.includes('w:eastAsia="ja-JP"'));
console.log('eventCount rFonts:', (xml.match(/w:eastAsia="Meiryo"/g) || []).length);
