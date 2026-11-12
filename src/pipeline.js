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
import * as jaModule from './ja/index.js';
import { normalizeJaEntryKey } from './ja/entrykey.js';
import { meaningWarnings, resolveMeaning } from './meanings.js';

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
  for (let idx = 0; idx < files.length; idx += 1) {
    const f = files[idx];
    // 多 P 视频的输入会被标成 subtitle.p2.srt / audio.p2.srt：
    // 文件名原样保留（解析器靠扩展名认格式，.srt 结尾照样认），
    // 另外把「P2」作为标签挂到片段上，方便界面/文档区分是哪一 P。
    const pm = String(f.name ?? '').match(/\.p(\d+)(?=\.\w+$)/);
    const pTag = pm ? `P${pm[1]}` : '';
    const { fragments, warnings: w } = parseByExt(f.ext, f.raw, f.name);
    for (const item of w) warnings.push({ ...item, src: f.name });
    if (f.kind) for (const frag of fragments) frag.kind = f.kind;
    if (pTag) for (const frag of fragments) frag.p = pTag;
    sources.push({ name: f.name, format: String(f.ext).toLowerCase(), count: fragments.length, p: pTag });
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
 * 日文版流水线（同步版）：分词器已在外部加载好，这里只做纯计算。
 *
 * 与英文的区别（每一条都是刻意的）：
 *   - 不做短语抽取（首版 ja 关闭，phraseCount 固定 0）
 *   - 不做词形还原的启发式猜测：只信词典给的 basic_form，没有就标 unknown
 *   - 不做英汉词典查词：日文首版不产出释义（T7 才接日汉词典）
 *   - 用法位置用 UTF-16 半开区间，由 tokenizer 的词元边界直接得出
 *
 * @param {Array<{name:string, ext:string, raw:string, kind?:string}>} files
 * @param {object} config resolveConfig 的返回值
 * @param {object} extra { tokenizer, decisions }
 */
export function digestJapaneseSync(files, config, extra = {}) {
  const { digestJaSync } = jaModule;
  const warnings = [];
  const sources = [];
  const allFragments = [];
  for (let idx = 0; idx < files.length; idx += 1) {
    const f = files[idx];
    const pm = String(f.name ?? '').match(/\.p(\d+)(?=\.\w+$)/);
    const pTag = pm ? `P${pm[1]}` : '';
    const { fragments, warnings: w } = parseByExt(f.ext, f.raw, f.name);
    for (const item of w) warnings.push({ ...item, src: f.name });
    if (f.kind) for (const frag of fragments) frag.kind = f.kind;
    if (pTag) for (const frag of fragments) frag.p = pTag;
    sources.push({ name: f.name, format: String(f.ext).toLowerCase(), count: fragments.length, p: pTag });
    allFragments.push(...fragments);
  }
  if (!allFragments.length) warnings.push({ level: 'warn', message: '输入里没解析出任何文本片段' });

  const ja = digestJaSync(allFragments, config, {
    tokenizer: extra.tokenizer,
    // 词表里「已掌握」的词要在抽取阶段就过滤（与英文 known 语义一致）；
    // entryKey 与裸词形两种形态都由 digestJaSync 内部处理
    known: extra.known,
  });
  for (const w of ja.warnings ?? []) warnings.push(w);

  const lex = config.lexicon ?? {};
  const minFreq = Number(lex.minFreq ?? 1);
  const excludeRe = safeRegex(lex.excludeRegex);
  const decisions = extra.decisions ?? {};
  const provider = extra.meaningProvider ?? null;
  const wordlistMeanings = extra.wordlistMeanings ?? null;

  const kept = [];
  const filtered = [];
  for (const it of ja.items) {
    if (excludeRe && excludeRe.test(it.word)) { filtered.push({ word: it.word, count: it.count, reason: '命中排除规则' }); continue; }
    if (it.count < minFreq) { filtered.push({ word: it.word, count: it.count, reason: '低于最低词频' }); continue; }

    // 释义三层优先级：人工修订 > 当前词表 > provider
    // 日文查词带读音与词性，同形异读不会串项；
    // 先按归一后的键查（兼容老 NUL 格式的 decisions / 词表卡片），再退回原键与裸词形。
    const keyNorm = normalizeJaEntryKey(it.entryKey);
    const rev = decisions[keyNorm] ?? decisions[it.entryKey] ?? decisions[it.word];
    const wl = wordlistMeanings
      ? wordlistMeanings.get(keyNorm) ?? wordlistMeanings.get(it.entryKey) ?? wordlistMeanings.get(it.word)
      : undefined;
    const rm = resolveMeaning({
      word: it.word,
      reading: it.reading,
      pos: it.pos,
      entryKey: it.entryKey,
      revision: rev?.meaning ? rev : undefined,
      wordlist: wl,
      provider,
    });

    kept.push({
      ...it,
      language: 'ja',
      posLabel: posLabel(it.pos),
      base: false,
      meaning: rm.meaning,
      meaningLanguage: rm.meaningLanguage,
      meaningSource: rm.meaningSource,
      meaningSourceDetail: rm.meaningSourceDetail,
      samples: it.usages.map((u) => ({ text: u.text, src: u.src, t: u.t })),
      sources: { [it.src]: it.count },
    });
  }
  kept.sort((a, b) => b.count - a.count || b.word.length - a.word.length || (a.word < b.word ? -1 : 1));
  filtered.sort((a, b) => b.count - a.count || (a.word < b.word ? -1 : 1));

  // 释义缺失按运行汇总（不逐词刷屏）
  const providerInfo = provider
    ? { status: provider.status ?? 'ok', error: provider.error ?? '' }
    : { status: 'unconfigured', error: '' };
  for (const w of meaningWarnings(kept, providerInfo)) warnings.push(w);

  const tags = tagSummary(kept);
  const topWords = kept.slice(0, 200).map((k) => ({
    word: k.word, display: k.display, count: k.count, pos: k.pos, posLabel: k.posLabel,
  }));

  return {
    version: ENGINE_VERSION,
    language: 'ja',
    sources,
    warnings,
    fragments: allFragments.length,
    stats: {
      fileCount: files.length,
      fragmentCount: allFragments.length,
      candidateCount: ja.items.length,
      keptCount: kept.length,
      filteredCount: filtered.length,
      phraseCount: 0,
      tokenCount: ja.stats.tokenCount,
      unknownItemCount: ja.stats.unknownItemCount,
      unknownItemRatio: ja.stats.unknownItemRatio,
      unknownTokenRatio: ja.stats.unknownTokenRatio,
      /** 有释义 / 无释义的词条数（给界面和报告用） */
      meaningCount: kept.filter((k) => k.meaning).length,
      meaningMissingCount: kept.filter((k) => !k.meaning).length,
    },
    dropped: ja.dropped,
    sections: buildSections(kept, config, null),
    tags,
    topWords,
    filtered: filtered.slice(0, 200),
    items: kept,
    /** 日文首版没有「已掌握」名单纳入过滤（词表接入在 T5） */
    known: [],
    lexicon: { tokenizerVersion: ja.tokenizerVersion, phraseCount: 0 },
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
    /** 用法条目：{text, skeleton, t, src, word, kind}；日文另带 {start, end, surface} */
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
    // ── 日文专有（英文条目这几个字段为空/undefined，不影响旧数据）──
    language: c.language,
    entryKey: c.entryKey,
    /** 读音：片假名（原形读音，不是活用形读音） */
    reading: c.reading ?? '',
    /** 同上，平假名版 */
    readingHiragana: c.readingHiragana ?? '',
    /** 是否词典没收录（未知词：只保留表面形，读音留空） */
    unknown: Boolean(c.unknown),
    /** 'dict' = 词典给出的基本形；'surface' = 没有可靠基本形，用表面形兜底 */
    lemmaSource: c.lemmaSource ?? '',
    /** 词典的细词性（サ変接続 / 固有名詞 …） */
    posDetail: c.posDetail ?? '',
    /** 合并词（サ変+する）的读音来源标记：true 表示读音是「名词读音+する原形读音」拼出来的 */
    merged: Boolean(c.merged),
    // ── 释义元信息（T4：标明语言与来源）──
    /** 释义语言：'zh' 中文 / 'ja' 日文 / 'en' 英文；空串 = 没释义 */
    meaningLanguage: c.meaningLanguage ?? '',
    /** 释义来源：'revision' 人工修订 / 'wordlist' 当前词表 / 'provider' 本地词典 / 'none' */
    meaningSource: c.meaningSource ?? (c.meaning ? 'provider' : 'none'),
    /** 来源细节（文件名/词表名），便于回溯 */
    meaningSourceDetail: c.meaningSourceDetail ?? '',
    /** 该条目的定位是否可靠：false = 原文字符映射退化，不要高亮 */
    offsetExact: c.offsetExact !== false,
  };
}
