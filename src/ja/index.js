/**
 * 日文引擎总入口：清洗 → 分词 → 抽词 → 聚合 → 读音补全 → 用法定位。
 *
 * 这是 T3 的全部逻辑，纯函数式（不碰 IO），由 pipeline 在 language==='ja' 时调用。
 *
 * 设计取舍（都有实测依据）：
 *   - **基本形读音 ≠ 活用读音**。kuromoji 给的 reading 是针对表面形的，
 *     住ん → スン；住む → スム。所以原形读音优先「查基本形本身」，
 *     查不到就留空，绝不用活用读音顶替。
 *   - **读音只信词典，不靠假名推断**。kuromoji 里没有的词，读音就是 ''。
 *   - **同形异读不合并**。索引键是 `基本形 + '#' + 词性`，走る(五段) 和
 *     走ら(未然) 会落到同一个 basic=走る，但词性相同才合并；
 *     连体词/副词与同形名词分开。
 *   - **offset 用原文 UTF-16 半开区间**，必须满足 text.slice(start,end) === 表面形。
 */
import { cleanJapanese, cleanJapaneseWithMap, splitSentencesJa, splitSentencesJaWithPos } from './clean.js';
import { collectJa, kataToHira, posFromJa } from './extract.js';
import { buildTokenizer, kuromojiVersion } from './tokenizer.js';
import { jaEntryKey, normalizeJaEntryKey } from './entrykey.js';

/** 已知词的读音缓存：key = 词 */
function makeReadingResolver(tokenizer) {
  const cache = new Map();
  return function resolve(lemma) {
    if (!lemma) return '';
    if (cache.has(lemma)) return cache.get(lemma);
    let reading = '';
    try {
      const toks = tokenizer.tokenize(lemma);
      // 只有当分词结果正好是「这一个词」且没落未知词时才信
      if (toks.length === 1) {
        const t = toks[0];
        const ok = t.basic_form && t.basic_form !== '*' && t.reading;
        if (ok && t.surface_form === lemma) reading = t.reading;
      }
    } catch { reading = ''; }
    cache.set(lemma, reading);
    return reading;
  };
}

/** 助动词「する」的原形读音（スル）—— 合并词拼读音时用，只查一次 */
function suruBaseReading(tokenizer) {
  try {
    const toks = tokenizer.tokenize('する');
    if (toks.length === 1 && toks[0].reading) return toks[0].reading;
  } catch { /* 忽略 */ }
  return '';
}

/**
 * 跑日文抽词。
 * @param {Array<{text:string,t?:number,src?:string,kind?:string}>} fragments
 * @param {object} config resolveConfig 结果
 * @param {object} extra { tokenizer } 可注入已建好的 tokenizer（测试用）
 */
export async function digestJa(fragments, config, extra = {}) {
  const tokenizer = extra.tokenizer ?? await buildTokenizer();
  return digestJaWith(fragments, config, { ...extra, tokenizer });
}

/**
 * 同步版：分词器必须已经加载好（kuromoji 的 tokenize 本身是同步的，
 * 只有「加载词典」是异步的）。run.js 里日文走的同步编排用这个。
 */
export function digestJaSync(fragments, config, extra = {}) {
  if (!extra.tokenizer) {
    const err = new Error('日文处理需要已加载的分词器');
    err.code = 'JA_TOKENIZER_NOT_READY';
    throw err;
  }
  return digestJaWith(fragments, config, extra);
}

function digestJaWith(fragments, config, extra = {}) {
  const tokenizer = extra.tokenizer;
  const lex = config.lexicon ?? {};
  const minLen = Math.max(1, Number(lex.minLen ?? 1));
  const minFreq = Math.max(1, Number(lex.minFreq ?? 1));
  const sampleLimit = Number(config.docx?.samplePerWord ?? 3);
  const suruReading = suruBaseReading(tokenizer);

  const stopwords = extra.stopwords ?? new Set();
  /**
   * 用户词表里「已掌握」的词。
   *
   * ⚠️ 两种形态都要认：
   *   - `entryKey`（`ja|日本|ニホン|prop.`）—— 精确区分同形异读
   *   - 裸词形（`日本`）—— 老词表 / 用户手写的 known.txt 只有词形
   * 只按裸词形比会误伤：标了 ニホン 不该连带把 ニッポン 也过滤掉。
   * 所以先按 entryKey 优先判定，没命中再看裸词形。
   */
  const knownSetRaw = extra.known instanceof Set
    ? extra.known
    : new Set(Array.from(extra.known ?? []));
  // 旧 known.txt / 旧卡片里可能是 NUL 格式的键，读进来时统一归一，
  // 否则升级后「已掌握」会静默失效（这是 m01994 要求核实的兼容点）。
  const knownSet = new Set(Array.from(knownSetRaw, (k) => normalizeJaEntryKey(k)));
  const isKnown = (entryKey, word) => knownSet.size > 0
    && (knownSet.has(normalizeJaEntryKey(entryKey)) || knownSet.has(word));
  const warnings = [];
  const dropped = { empty: 0, noJapanese: 0, stopword: 0, posFiltered: 0, known: 0 };
  const byKey = new Map();
  let fragmentCount = 0;

  for (const frag of fragments) {
    const original = String(frag.text ?? '');
    const {
      clean, starts: mapStarts, ends: mapEnds, exact: mapExact, dropped: isDropped, reason,
    } = cleanJapaneseWithMap(original);
    if (isDropped) {
      if (reason === 'no-japanese') dropped.noJapanese += 1;
      else dropped.empty += 1;
      continue;
    }
    fragmentCount += 1;

    // 逐句分词：(1) 保证 offset 在句内可用，(2) 句子边界内做 サ変 合并
    for (const sentence of splitSentencesJaWithPos(clean)) {
      let tokens;
      try {
        tokens = tokenizer.tokenize(sentence.text);
      } catch (e) {
        warnings.push({ level: 'warn', message: `分词失败：${e.message}`, src: frag.src });
        continue;
      }
      // 词元边界先落在「分析文本」的坐标系里，下面统一换算回原文
      const entries = collectJa(tokens, {
        minLen, suruReading, frag: { ...frag, text: sentence.text }, sampleLimit,
      });

      for (const e of entries) {
        // ① 分析文本内部自检：占位 offsets 是句内坐标
        if (sentence.text.slice(e.start, e.end) !== e.surface) {
          warnings.push({
            level: 'warn',
            message: `分析文本 offset 不一致：${e.surface}（${e.start}-${e.end}）`,
            src: frag.src,
          });
          continue;
        }
        if (stopwords.has(e.word)) { dropped.stopword += 1; continue; }

        // ② 换算到原文坐标：分析文本下标 → 清洗文本下标 → 原文下标
        //
        // ⚠️ 必须用「区间」而不是「起点」：`ｶﾞ`(2字) → `ガ`(1字) 时，
        // 只取起点会得到 [0,1)，丢掉浊点；`㍿`(1字) → `株式会社` 时，
        // 四个字的起点都是 0，只用起点也拼不回原文。
        // 所以取「覆盖区间的最小起点 ~ 最大终点」。
        const aStart = sentence.start + e.start;
        const aEnd = sentence.start + e.end;
        if (aStart < 0 || aEnd > mapStarts.length || aEnd <= aStart) {
          warnings.push({ level: 'warn', message: `原文映射越界：${e.surface}`, src: frag.src });
          continue;
        }
        let oStart = Infinity;
        let oEnd = -Infinity;
        for (let k = aStart; k < aEnd; k += 1) {
          if (mapStarts[k] < oStart) oStart = mapStarts[k];
          if (mapEnds[k] > oEnd) oEnd = mapEnds[k];
        }
        if (!Number.isFinite(oStart) || !Number.isFinite(oEnd) || oEnd <= oStart) {
          warnings.push({ level: 'warn', message: `原文映射缺失：${e.surface}`, src: frag.src });
          continue;
        }
        const surfaceOriginal = original.slice(oStart, oEnd);

        // 聚合键必须包含读音：同形同词性的词可能读音不同（日本 ニホン / ニッポン），
        // 只按 word#pos 合并会把两个不同的词并成一条。
        // 读音未知时用 '\u0000?' 明确标记「未知」，不能和空串混淆。
        const readKey = e.reading || (e.unknown ? '\u0000?' : '');
        const key = jaEntryKey(e.word, e.pos, e.reading, e.unknown);
        let agg = byKey.get(key);
        if (!agg) {
          agg = {
            word: e.word,
            display: e.display,
            pos: e.pos,
            posDetail: e.posDetail,
            unknown: e.unknown,
            lemmaSource: e.lemmaSource,
            // 合并词（サ変+する）的读音是名词读音拼 する 拼出来的，随条目带上来
            readingFromToken: e.reading || '',
            readingUnknown: e.unknown && !e.reading,
            count: 0,
            forms: {},
            samples: [],
            usages: [],
            offsetUnreliable: false,
            firstT: e.t,
            sources: {},
          };
          byKey.set(key, agg);
        }
        agg.count += 1;
        agg.forms[e.surface] = (agg.forms[e.surface] ?? 0) + 1;
        if (agg.firstT == null && e.t != null) agg.firstT = e.t;
        if (e.src) agg.sources[e.src] = (agg.sources[e.src] ?? 0) + 1;

        // 用法样本去重（同一句同一位置只留一条），位置一律是**原文**的 UTF-16 半开区间
        const dup = agg.usages.some((u) => u.text === original && u.start === oStart);
        if (!dup && agg.usages.length < Number(config.docx?.usagePerWord ?? 5)) {
          // ⚠️ exact=false 时映射退化过：位置可能偏，不能当成精确高亮。
          // 这时把 start/end 置空、只保留整句原文 + ok=false，下游据此不画高亮。
          const reliable = mapExact !== false;
          agg.usages.push({
            text: original,
            start: reliable ? oStart : null,
            end: reliable ? oEnd : null,
            surface: e.surface,
            /** 原文里被覆盖的那一段（NFKC 前长什么样） */
            surfaceOriginal: reliable ? surfaceOriginal : '',
            /** 该定位是否可信。false = 只能给整句，不能给区间 */
            offsetExact: reliable,
            t: e.t,
            src: e.src,
          });
          if (!reliable) agg.offsetUnreliable = true;
        }
        if (agg.samples.length < sampleLimit && !agg.samples.some((s) => s.text === original)) {
          agg.samples.push({ text: original, src: e.src, t: e.t });
        }
      }
    }
  }

  // 读音补全：条目自带读音优先（合并词是拼装出来的），
  // 否则用「基本形本身」去查词典；查不到就留空，绝不用活用读音顶替。
  const resolve = makeReadingResolver(tokenizer);
  const items = [];
  for (const agg of byKey.values()) {
    if (agg.count < minFreq) { dropped.posFiltered += 1; continue; }
    // 聚合时已经区分过读音（同形同词性不同读音不会并到一起），所以这里直接沿用
    const reading = agg.unknown ? '' : (agg.readingFromToken || resolve(agg.word));
    // 稳定键：language + lemma + lemmaReading + pos，读音未知时用 ? 占位
    const entryKey = jaEntryKey(agg.word, agg.pos, reading, agg.unknown);
    // 词表里已掌握 → 不进结果（与英文路径的 known 过滤语义一致）
    if (isKnown(entryKey, agg.word)) { dropped.known += 1; continue; }
    items.push({
      ...agg,
      language: 'ja',
      entryKey,
      reading,
      readingHiragana: reading ? kataToHira(reading) : '',
      /** 这条的原文定位是否可信；false 时下游不能画高亮区间 */
      offsetExact: agg.offsetUnreliable !== true,
      // 展示用词性标签走项目的 POS_ZH
      posLabelKey: agg.pos,
      meaning: '',
      meaningLanguage: '',
      meaningSource: '',
    });
  }

  // 排序：先按出现次数，再按未知词后置（不认识的词放后面，先看确定的）
  items.sort((a, b) => b.count - a.count
    || Number(a.unknown) - Number(b.unknown)
    || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0));

  const unknownItems = items.filter((it) => it.unknown);
  const totalTokens = items.reduce((n, it) => n + it.count, 0);
  const unknownTokens = unknownItems.reduce((n, it) => n + it.count, 0);

  return {
    items,
    stats: {
      fragmentCount,
      itemCount: items.length,
      tokenCount: totalTokens,
      unknownItemCount: unknownItems.length,
      unknownTokenCount: unknownTokens,
      /** 未知词出现次数占比（按 token 计） */
      unknownTokenRatio: totalTokens ? unknownTokens / totalTokens : 0,
      /** 未知词去重词条占比（按词条计） */
      unknownItemRatio: items.length ? unknownItems.length / items.length : 0,
    },
    dropped,
    phraseCount: 0, // 首版日文不做短语抽取
    tokenizerVersion: kuromojiVersion(),
    warnings,
  };
}

export { cleanJapanese, splitSentencesJa, posFromJa, kataToHira };
export { collectJa };
// 条目键的实现独立成模块（词表 store / 导入器 / Web 服务端也要用，但不该拖进分词器）
export { jaEntryKey, parseJaEntryKey, normalizeJaEntryKey, LEGACY_JA_KEY_PREFIX } from './entrykey.js';
