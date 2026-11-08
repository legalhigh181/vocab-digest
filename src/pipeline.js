/**
 * 流水线主干：解析 → 清洗 → 切词 → 还原 → 过滤 → 分类 → 分章。
 *
 * 纯函数式：输入（已读入的文件内容 + 配置），输出 digest 结果对象（可 JSON 序列化、可复现）。
 * 不做任何 IO —— 读写文件在 run.js 里。
 */
import { POS_ORDER, createClassifier, groupByPos, groupBySource, groupByTag, posLabel, sortItems, tagSummary } from './classify.js';
import { extractCandidates } from './extract.js';
import { loadLexicon } from './lexicon/lexicon.js';
import { parseByExt } from './parsers.js';
import { extractPhrases } from './phrases.js';
import { safeRegex } from './util.js';
import { collectPhraseUsages, collectUsages } from './usages.js';

export const ENGINE_VERSION = '1.0.0';

/**
 * @param {Array<{name:string, ext:string, raw:string, kind?:string}>} files
 * @param {object} config resolveConfig 的返回值
 * @param {object} extra { decisions }
 */
export function digest(files, config, extra = {}) {
  const warnings = [];
  const lexicon = loadLexicon(config, { decisions: extra.decisions, patchDecisions: extra.patchDecisions });
  const wlPatch = extra.wlPatch ?? { pos: {}, words: new Set() };

  // 缺词表必须报错，不能静默用空表 —— 空表会让「过滤」失效，用户拿到的是噪声
  if (lexicon.missing.length) {
    const err = new Error(
      `缺少词表文件：${lexicon.missing.map((m) => `${m.key} (${m.path})`).join('、')}`,
    );
    err.code = 'LEXICON_MISSING';
    err.missing = lexicon.missing;
    throw err;
  }

  const allFragments = [];
  const sources = [];
  for (const f of files) {
    const { fragments, warnings: w } = parseByExt(f.ext, f.raw, f.name);
    for (const item of w) warnings.push({ ...item, src: f.name });
    if (f.kind) for (const frag of fragments) frag.kind = f.kind;
    sources.push({ name: f.name, format: String(f.ext).toLowerCase(), count: fragments.length });
    allFragments.push(...fragments);
  }
  if (!allFragments.length) warnings.push({ level: 'warn', message: '输入里没解析出任何文本片段' });

  const lex = config.lexicon ?? {};
  const minLen = Number(lex.minLen ?? 3);
  const minFreq = Number(lex.minFreq ?? 1);

  // 停用词直接作为额外过滤集合（不区分大小写）
  const extract = extractCandidates(allFragments, {
    minLen,
    samplePerWord: Number(config.docx?.samplePerWord ?? 3),
    lemmatize: lexicon.lemmatize,
    extraStop: lexicon.stopwords,
    dropShout: true,
    dictionary: lexicon.dictionary,
  });

  const phraseResult = extractPhrases(allFragments, {
    minN: 2,
    maxN: 4,
    minCount: Math.max(2, minFreq),
    stopwords: lexicon.stopwords,
    lemmatize: lexicon.lemmatize,
    samplePerWord: 2,
    minPmi: Number(lex.phraseMinPmi ?? 3),
    minEntropy: Number(lex.phraseMinEntropy ?? 0.8),
    // 口语短语白名单：data/colloquial.json 里登记的短语无条件保留
    whitelist: lexicon.colloquialPhrases ?? new Map(),
  });

  const classify = createClassifier({
    pos: { ...wlPatch.pos, ...lexicon.pos },
    decisions: lexicon.decisions,
    base: lexicon.base,
  });

  const excludeRe = safeRegex(lex.excludeRegex);
  const colWords = lexicon.colloquialWords ?? new Map();
  // 本地英汉词典（ECDICT）是可选项：文件不在就整个跳过，不影响主流程
  const dict = extra.dict ?? null;
  const dictLookup = (w) => {
    if (!dict || !dict.ready) return null;
    return dict.lookup(w);
  };
  const kept = [];
  const filtered = [];
  for (const cand of extract.candidates.values()) {
    const w = cand.word;
    if (lexicon.known.has(w)) { filtered.push({ word: w, count: cand.count, reason: '已知词' }); continue; }
    if (excludeRe && excludeRe.test(w)) { filtered.push({ word: w, count: cand.count, reason: '命中排除规则' }); continue; }
    if (cand.count < minFreq) { filtered.push({ word: w, count: cand.count, reason: '低于最低词频' }); continue; }
    const cls = classify(w, cand.count, false);
    // 口语词表优先补词性与释义：口语里 day / now / nothing 这类词靠后缀启发式永远判不出词性
    const col = colWords.get(w);
    const pos = col?.pos || cls.pos;
    // 释义来源优先级：人工回写（decisions）> 用户词表 > 本地英汉词典 > 口语词表
    const wl = wlPatch.words.has(w) || wlPatch.words.has(cand.word) ? lexicon.decisions[w] : null;
    const dic = dictLookup(w) ?? dictLookup(cand.word);
    kept.push({
      ...cand,
      ...cls,
      pos,
      posLabel: posLabel(pos),
      colloquial: Boolean(col),
      meaning: lexicon.decisions[w]?.meaning || wl?.meaning || dic?.translation || col?.meaning || '',
      phonetic: dic?.phonetic || '',
      dictPos: dic?.pos || '',
      scene: col?.scene ?? [],
    });
  }

  for (const p of phraseResult.phrases) {
    if (lexicon.known.has(p.word)) continue;
    const col = lexicon.colloquialPhrases?.get(p.word);
    const dic = dictLookup(p.word);
    kept.push({
      ...p,
      pos: 'phr.',
      posLabel: posLabel('phr.'),
      section: 'phr.',
      base: false,
      colloquial: Boolean(col),
      meaning: lexicon.decisions[p.word]?.meaning || dic?.translation || col?.meaning || '',
      phonetic: dic?.phonetic || '',
      dictPos: dic?.pos || '',
      scene: col?.scene ?? p.scene ?? [],
    });
  }

  kept.sort(sortItems);
  filtered.sort((a, b) => b.count - a.count || (a.word < b.word ? -1 : 1));

  // 用法（usages）：每条词条跟一组「原话 + 骨架 + 时间点」，这是用户要的「标注原文具体用法」。
  // 词用表面形态匹配（feeling / feels / felt 都算 feel），短语用原文匹配。
  const usageLimit = Number(config.docx?.usagePerWord ?? 5);
  for (const it of kept) {
    it.usages = it.pos === 'phr.'
      ? collectPhraseUsages(allFragments, it.word, { limit: usageLimit })
      : collectUsages(allFragments, it.word, { limit: usageLimit, forms: it.forms ?? {} });
    // 旧字段 samples 保留给 Word 渲染，内容与 usages 对齐（避免两套数据不一致）
    if (it.usages.length) {
      it.samples = it.usages.map((u) => ({ text: u.text, src: u.src, t: u.t }));
    }
  }

  const sections = buildSections(kept, config, lexicon);
  const tags = tagSummary(kept);
  const topWords = kept.slice(0, 200).map((k) => ({
    word: k.word, display: k.display, count: k.count, pos: k.pos, posLabel: k.posLabel,
  }));

  return {
    version: ENGINE_VERSION,
    sources,
    warnings,
    fragments: allFragments.length,
    stats: {
      fileCount: files.length,
      fragmentCount: allFragments.length,
      candidateCount: extract.candidates.size + phraseResult.phrases.length,
      keptCount: kept.length,
      filteredCount: filtered.length,
      phraseCount: phraseResult.phrases.length,
    },
    dropped: extract.dropped,
    sections,
    tags,
    topWords,
    filtered: filtered.slice(0, 200),
    items: kept,
    /** 词表系统里「已掌握」的词：UI 上灰显用 */
    known: [...lexicon.known],
    lexicon: {
      stopwords: lexicon.stopwords.size,
      known: lexicon.known.size,
      base: lexicon.base.size,
      pos: Object.keys(lexicon.pos).length,
      dictionary: lexicon.dictionary.size,
    },
  };
}

/**
 * 分章：按 `classify.by` 指定的标签维度分章（默认 ['pos']）。
 * 多个维度 = 多套并列章节（一个词会同时出现在「词性」章和「难度」章里），
 * 阅读时可以按标签跳着看 —— 这就是「按标签选择查看类型」。
 */
export function buildSections(items, config, lexicon) {
  const cls = config.classify ?? {};
  const dims = Array.isArray(cls.by) && cls.by.length
    ? cls.by
    : (cls.byPos === false && !cls.bySource ? [] : [cls.byPos === false ? null : 'pos', cls.bySource ? 'source' : null].filter(Boolean));

  const sections = [];
  for (const dim of dims) {
    if (dim === 'pos') {
      for (const g of groupByPos(items)) sections.push({ key: g.key, dim: 'pos', label: g.label, items: g.items.map(toItem) });
    } else if (dim === 'source') {
      for (const g of groupBySource(items)) sections.push({ key: g.key, dim: 'source', label: g.label, items: g.items.map(toItem) });
    } else {
      for (const g of groupByTag(items, dim)) sections.push({ key: g.key, dim, label: g.label, items: g.items.map(toItem) });
    }
  }
  if (!sections.length) sections.push({ key: 'all', dim: 'all', label: `全部词汇（${items.length}）`, items: items.map(toItem) });
  void lexicon;
  return sections;
}

export function toItem(c) {
  return {
    word: c.word,
    display: c.display,
    count: c.count,
    pos: c.pos,
    posLabel: c.posLabel,
    meaning: c.meaning ?? '',
    samples: c.samples ?? [],
    /** 用法条目：{text, skeleton, t, src, word, kind} */
    usages: c.usages ?? [],
    firstT: c.firstT,
    sources: c.sources ?? {},
    base: Boolean(c.base),
    forms: c.forms ?? {},
    /** 是否命中 data/colloquial.json（口语词表） */
    colloquial: Boolean(c.colloquial),
    /** 场景标签：看病 / 购物 / 日常 … */
    scene: c.scene ?? [],
    /** 短语专有：PMI 强度、是否来自白名单 */
    pmi: c.pmi,
    fromList: Boolean(c.fromList),
  };
}
