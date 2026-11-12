/**
 * 文档模型 → document.xml。
 *
 * doc 结构：
 * {
 *   title, subtitle, generatedAt,       // 封面
 *   sources: [{ name, format, count }], // 输入清单
 *   stats: { fileCount, fragmentCount, keptCount, filteredCount, phraseCount },
 *   params: [{ key, value }],           // 生成参数（可复现性）
 *   tags: [{ key, label, count }],      // 可用标签（按标签翻章）
 *   sections: [{ key, label, intro, items }],
 *   topWords: [{ word, count, posLabel }],
 *   filtered: [{ word, count, reason }],
 * }
 *
 * 注意：generatedAt 只出现在「封面页脚备注」而不是每个词条里，
 * 这样同一输入重跑时正文部分可以逐字节一致（自检比对用）。
 */
import { fmtTime } from '../util.js';
import { TAG_DIM_LABELS } from '../classify.js';
import { cambridgeUrl } from '../lexicon/ecdict.js';
import {
  bulletPara,
  document,
  escapeXml,
  hyperlinkRun,
  para,
  pageBreak,
  run,
  table,
  tocField,
} from './ooxml.js';

export let POS_ZH = {
  'n.': '名词',
  'v.': '动词',
  'adj.': '形容词',
  'adv.': '副词',
  'phr.': '短语',
  prop: '专有名词',
  'prop.': '专有名词',
  num: '数词',
  other: '其他',
};

/**
 * 各语言的展示层默认值。
 *
 * - `titlePrefix`：封面与 run.json 标题的默认前缀（以前硬编码「英语词汇整理」）
 * - `eastAsiaFont`：正文亚洲字形用的字体。日文系统上没有「等线」，用 Meiryo；
 *   用户仍可在 config 里用 `docx.fontCn` 覆盖
 * - `eastAsiaLang`：styles 里 `<w:lang w:eastAsia>`，决定 Word 用什么语言规则排版
 * - `readingLabel`：读音前面的小标题
 * - `unknownLabel`：kuromoji 词表里查不到的词，标记在这里，绝不给假读音
 */
export const LANGUAGE_DOC_DEFAULTS = {
  en: { titlePrefix: '英语词汇整理', eastAsiaFont: '等线', eastAsiaLang: 'zh-CN', readingLabel: '音标' },
  ja: { titlePrefix: '日语词汇整理', eastAsiaFont: 'Meiryo', eastAsiaLang: 'ja-JP', readingLabel: '读音', unknownLabel: '未收录' },
};

/** 取某种语言的展示默认值（未知语言按英文，兼容旧数据） */
export function docDefaultsFor(language) {
  return LANGUAGE_DOC_DEFAULTS[language === 'ja' ? 'ja' : 'en'];
}

/**
 * 解析出本次渲染该用的字体系。
 * config 里的 fontCn / fontEn 优先；没配就按语言取默认。
 */
function fontOf(doc, opts) {
  const lang = doc?.language === 'ja' ? 'ja' : 'en';
  const d = LANGUAGE_DOC_DEFAULTS[lang];
  const eastAsia = opts.eastAsia ?? doc?.eastAsiaFont ?? d.eastAsiaFont;
  return { lang, eastAsia, eastAsiaLang: opts.eastAsiaLang ?? doc?.eastAsiaLang ?? d.eastAsiaLang };
}

/** 日文词条要带读音/假名；英文词条不受影响 */
function isJaItem(it) {
  return it?.language === 'ja';
}

/**
 * 读音片段：`读音：ニホン（にほん）· 汉 にほん(のべ) · 用时 ニホン`
 * 只有日文且有读音时返回数组，否则空数组。
 */
function readingRuns(it) {
  if (!isJaItem(it) || !it.reading) return [];
  const out = [run(`  ${LANGUAGE_DOC_DEFAULTS.ja.readingLabel}：${it.reading}`, { size: 18 })];
  if (it.readingHiragana && it.readingHiragana !== it.reading) {
    out.push(run(`（${it.readingHiragana}）`, { size: 18 }));
  }
  // 基本形读音 ≠ 活用读音：原文里实际怎么念的写出来，单词知道怎么读、用起来才知道怎么读
  if (it.usageReading && it.usageReading !== it.reading) {
    out.push(run(` · 用时 ${it.usageReading}`, { size: 16, color: '7F7F7F' }));
  }
  return out;
}

/**
 * 词条小节标题行。
 * links 是外部超链接表（{url → rId}），有就附一个「剑桥 ↗」链接 —— 离线看文档时 Ctrl+点能开。
 */
function itemPara(it, links, font) {
  const head = [
    run(it.display || it.word, { bold: true, size: 24, eastAsia: font.eastAsia }),
    run(`  ${it.posLabel ?? ''}`, { size: 20, eastAsia: font.eastAsia }),
    run(`  出现 ${it.count} 次`, { size: 18, eastAsia: font.eastAsia }),
  ];
  if (it.base) head.push(run('  · 基础词', { size: 16, eastAsia: font.eastAsia }));
  if (it.colloquial) head.push(run('  · 口语', { size: 16, eastAsia: font.eastAsia }));
  head.push(...readingRuns(it));
  // 未收录：读音留空是有意的（编造读音比没有读音更害人），标出来读者才知道这不是漏了
  if (isJaItem(it) && it.unknown) {
    head.push(run(`  · ${LANGUAGE_DOC_DEFAULTS.ja.unknownLabel}`, { size: 16, color: 'C00000', eastAsia: font.eastAsia }));
  }
  const url = cambridgeUrl(it.word || it.display || '');
  if (url && links && links.has(url)) {
    head.push(run('  ', { size: 16, eastAsia: font.eastAsia }));
    head.push(hyperlinkRun('剑桥 ↗', links.get(url), { size: 16 }));
  }
  return para(head, { style: 'Heading2' });
}

function meaningPara(it, font) {
  if (!it.meaning) return null;
  return para([run(it.meaning, { size: 20, eastAsia: font.eastAsia })], { style: 'Quote' });
}

function samplesParas(it, font) {
  const out = [];
  const ea = font?.eastAsia;
  // 优先用 usages（带句法骨架）；没有就退回 samples（只有原句）
  const list = it.usages?.length ? it.usages : (it.samples ?? []);
  // 定位不可靠时（NFKC 映射退化 / 只有整句），明确告诉读者别把它当成准确定位
  if (it.offsetExact === false) {
    out.push(bulletPara([
      run('定位提示：', { size: 16, color: 'C00000', eastAsia: ea }),
      run('这条词的原文位置无法精确对应（清洗或字形归一改变了长度），下面只给整句，不给高亮区间。', { size: 16, color: '7F7F7F', eastAsia: ea }),
    ]));
  }
  for (const s of list) {
    const where = [s.src, Number.isFinite(s.t) ? `（${fmtTime(s.t)}）` : ''].join('');
    const line = [`“${s.text}”`, where ? `  —— ${where}` : ''];
    out.push(bulletPara([
      run(line[0], { italic: true, size: 19, eastAsia: ea }),
      run(line[1], { size: 17, color: '7F7F7F', eastAsia: ea }),
    ]));
    if (s.skeleton && s.skeleton !== s.text) {
      out.push(bulletPara([
        run('用法：', { size: 16, color: '7F7F7F', eastAsia: ea }),
        run(s.skeleton, { size: 18, color: '1F4E79', eastAsia: ea }),
      ]));
    }
    // 日文：带出读音与该词在原文中的表层形（NFKC 前后可能不同）
    if (s.surfaceOriginal && s.surfaceOriginal !== s.surface) {
      out.push(bulletPara([
        run('原文写作：', { size: 15, color: '7F7F7F', eastAsia: ea }),
        run(s.surfaceOriginal, { size: 17, eastAsia: ea }),
      ]));
    }
  }
  return out;
}

function metaPara(it, font) {
  const parts = [];
  if (Number.isFinite(it.firstT)) parts.push(`首次出现：${fmtTime(it.firstT)}`);
  const srcs = Object.keys(it.sources ?? {});
  if (srcs.length) parts.push(`来源：${srcs.join('、')}`);
  const forms = Object.keys(it.forms ?? {}).filter((f) => f !== String(it.word).toLowerCase());
  if (forms.length) parts.push(`形态：${forms.slice(0, 6).join('、')}`);
  // 日文：词性细分与词形来源（kuromoji 归一到基本形 / 原文本身就是基本形）
  if (it.posDetail) parts.push(`词性细分：${it.posDetail}`);
  if (it.lemmaSource) {
    const label = it.lemmaSource === 'basic_form' ? 'kuromoji 基本形' : String(it.lemmaSource);
    parts.push(`词形来源：${label}`);
  }
  if (it.scene?.length) parts.push(`场景：${it.scene.join('、')}`);
  if (it.colloquial) parts.push('口语词表');
  if (it.fromList) parts.push('短语白名单');
  if (!parts.length) return null;
  return para([run(parts.join('　|　'), { size: 16, color: '7F7F7F', eastAsia: font?.eastAsia })], { style: 'Caption' });
}

/**
 * 收集文档里要用的外部超链接（剑桥词典），返回 { url → rId }。
 * 顺序稳定：按词条出现顺序分配 rId，保证同一输入重跑字节一致。
 */
export function collectLinks(doc) {
  const map = new Map();
  let n = 0;
  for (const sec of doc.sections ?? []) {
    for (const it of sec.items ?? []) {
      const url = cambridgeUrl(it.word || it.display || '');
      if (!url || map.has(url)) continue;
      map.set(url, `rId${100 + n}`);
      n++;
    }
  }
  return map;
}

/**
 * 生成整篇 document.xml。
 * @param {object} doc 文档模型（`doc.language` 决定标题前缀、字体与读音展示）
 * @param {object} opts { toc, fontCn, fontEn, eastAsia, eastAsiaLang, links }
 */
export function buildDocumentXml(doc, opts = {}) {
  const withToc = opts.toc !== false;
  const links = opts.links ?? null;
  const font = fontOf(doc, opts);
  const langDefaults = LANGUAGE_DOC_DEFAULTS[font.lang];
  const out = [];

  // ── 封面 ────────────────────────────────────────────────
  // 标题前缀按语言取：日语文档不能还叫「英语词汇整理」
  out.push(para([run(doc.title ?? langDefaults.titlePrefix, { eastAsia: font.eastAsia })], { style: 'Title' }));
  if (doc.subtitle) out.push(para([run(doc.subtitle)], { style: 'Subtitle' }));
  if (doc.generatedAt) out.push(para([run(`生成时间：${doc.generatedAt}`, { size: 18, color: '7F7F7F' })], { style: 'Subtitle' }));

  // ── 概览 ────────────────────────────────────────────────
  const st = doc.stats ?? {};
  out.push(para([run('一、处理概览', { bold: true, size: 26, eastAsia: font.eastAsia })], { spaceBefore: 360, spaceAfter: 120 }));
  out.push(table(['项目', '数值'], [
    ['输入文件数', String(st.fileCount ?? 0)],
    ['文本片段数（弹幕/字幕条）', String(st.fragmentCount ?? 0)],
    ['提取到的不重复词条', String(st.keptCount ?? 0)],
    ['被过滤的词条', String(st.filteredCount ?? 0)],
    ['抽取到的短语', String(st.phraseCount ?? 0)],
  ], { widths: [4200, 2400], eastAsia: font.eastAsia }));

  if (Array.isArray(doc.sources) && doc.sources.length) {
    out.push(para([run('二、输入清单', { bold: true, size: 26, eastAsia: font.eastAsia })], { spaceBefore: 320, spaceAfter: 120 }));
    out.push(table(['文件', '格式', '片段数'], doc.sources.map((s) => [s.name, s.format, String(s.count)]), { widths: [6200, 1400, 1400], eastAsia: font.eastAsia }));
  }

  if (Array.isArray(doc.params) && doc.params.length) {
    out.push(para([run('三、生成参数', { bold: true, size: 26, eastAsia: font.eastAsia })], { spaceBefore: 320, spaceAfter: 120 }));
    out.push(table(['参数', '取值'], doc.params.map((p) => [p.key, String(p.value)]), { widths: [4200, 4200], eastAsia: font.eastAsia }));
  }

  // ── 标签索引（按标签跳章）────────────────────────────────
  const tags = doc.tags ?? null;
  if (tags && Object.keys(tags).length) {
    out.push(para([run('四、标签索引', { bold: true, size: 26, eastAsia: font.eastAsia })], { spaceBefore: 320, spaceAfter: 120 }));
    out.push(para([run('同一个词会同时出现在多个标签章里；想只看某一类，直接跳到对应标签章即可。', { size: 18, color: '7F7F7F', eastAsia: font.eastAsia })], { spaceAfter: 120 }));
    const rows = [];
    for (const [dim, list] of Object.entries(tags)) {
      for (const t of list) rows.push([TAG_DIM_LABELS[dim] ?? dim, t.label, String(t.count)]);
    }
    out.push(table(['标签维度', '标签', '词条数'], rows, { widths: [2000, 5200, 1800], eastAsia: font.eastAsia }));
  }

  // ── 目录 ────────────────────────────────────────────────
  if (withToc) {
    out.push(para([run('目录', { bold: true, size: 26, eastAsia: font.eastAsia })], { pageBreak: true, spaceAfter: 120 }));
    out.push(tocField({ levels: '1-2' }));
  }

  // ── 各标签章节 ──────────────────────────────────────────
  const sections = doc.sections ?? [];
  for (const sec of sections) {
    out.push(para([run(sec.label, { eastAsia: font.eastAsia })], { style: 'Heading1', pageBreak: true }));
    if (sec.intro) out.push(para([run(sec.intro, { size: 18, color: '7F7F7F', eastAsia: font.eastAsia })], { spaceAfter: 120 }));
    for (const it of sec.items ?? []) {
      out.push(itemPara(it, links, font));
      const mp = meaningPara(it, font);
      if (mp) out.push(mp);
      out.push(...samplesParas(it, font));
      const meta = metaPara(it, font);
      if (meta) out.push(meta);
    }
  }

  // ── 附录 A：词频总表 ────────────────────────────────────
  if (Array.isArray(doc.topWords) && doc.topWords.length) {
    out.push(para([run('附录 A · 词频总表', { eastAsia: font.eastAsia })], { style: 'Heading1', pageBreak: true }));
    out.push(table(['排名', '词', '词性', '次数'], doc.topWords.map((w, i) => [
      String(i + 1), w.display ?? w.word, w.posLabel ?? '', String(w.count),
    ]), { widths: [900, 4200, 1800, 1400], eastAsia: font.eastAsia }));
  }

  // ── 附录 B：被过滤的词 ──────────────────────────────────
  if (Array.isArray(doc.filtered) && doc.filtered.length) {
    out.push(para([run('附录 B · 被过滤的词', { eastAsia: font.eastAsia })], { style: 'Heading1', pageBreak: true }));
    out.push(para([run('以下词因为「已掌握 / 低于最低词频 / 命中排除规则」没有进入正文。', { size: 18, color: '7F7F7F', eastAsia: font.eastAsia })]));
    out.push(table(['词', '次数', '原因'], doc.filtered.map((f) => [f.word, String(f.count), f.reason]), { widths: [3600, 1400, 3800], eastAsia: font.eastAsia }));
  }

  // ── 页脚备注 ────────────────────────────────────────────
  out.push(para([run('本文件由 vocab-digest 自动生成；词条释义可回写到 data/pos.json 与 decisions.json 后重新渲染。', { size: 16, color: '7F7F7F', eastAsia: font.eastAsia })], { spaceBefore: 360 }));
  void escapeXml;
  void pageBreak;

  return document(out.join(''));
}
