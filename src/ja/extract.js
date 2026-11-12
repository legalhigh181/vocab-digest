/**
 * 日文抽词：分词 → 词性映射 → サ変名詞+する 合并 → 未知词标记 → 读音。
 *
 * 输出契约（和英文侧 items 对齐，额外带日文专有字段）：
 *   {
 *     word:           索引键（基本形；未知词 = 表面形）
 *     display:        展示形（基本形；未知词 = 表面形）
 *     reading:        **基本形**的片假名读音；取不到就是 ''（绝不编造）
 *     readingHiragana: 基本形读音的平假名写法；取不到就是 ''
 *     pos:            'n.' / 'v.' / 'adj.' / 'adv.' / 'aux.' / 'int.' / 'other'
 *     posDetail:      更细的日语词性（名詞-固有名詞 / 動詞-自立 …）
 *     unknown:        kuromoji 词典里没有这个词
 *     lemmaSource:    'dictionary'（基本形来自词典）| 'surface'（回退到表面形）
 *     count / forms / samples / firstT / sources
 *   }
 */

/** 日文词性 → 项目内部词性标签 */
export function posFromJa(pos, detail1) {
  switch (pos) {
    case '名詞':
      if (detail1 === '固有名詞') return 'prop.';
      if (detail1 === '数') return 'num.';
      if (detail1 === '代名詞') return 'pron.';
      if (detail1 === '非自立' || detail1 === '接尾' || detail1 === '副詞可能') return 'n.';
      return 'n.';
    case '動詞':
      // 非自立（いる/くる/しまう 这类补助动词）不单独成词
      return detail1 === '非自立' ? 'aux.' : 'v.';
    case '形容詞':
      return 'adj.';
    case '形容動詞':
      return 'adj.';
    case '副詞':
      return 'adv.';
    case '助動詞':
      return 'aux.';
    case '助詞':
      return 'part.';
    case '接続詞':
      return 'conj.';
    case '連体詞':
      return 'adj.';
    case '感動詞':
      return 'int.';
    case '接頭詞':
    case '接尾詞':
      return 'affix.';
    case '記号':
      return 'sym.';
    case 'フィラー':
      return 'filler.';
    default:
      return 'other';
  }
}

/** 这些词性不当作「要学的词」：助词、助动词、记号、感叹词、接头/接尾 */
const SKIP_POS = new Set(['part.', 'aux.', 'sym.', 'filler.', 'affix.', 'int.']);

/** サ変接続 名詞后面能合并的「する」类词形 */
const SURU_FORMS = new Set(['する', 'し', 'さ', 'す', 'せ', 'しよ', 'しろ', 'さよ']);

/**
 * 形式名词：名詞-非自立 里的这一批没有词汇意义，进词表是噪声。
 * （「こと」「もの」「の」「ところ」这类；「いる」「くる」已由 動詞-非自立 过滤）
 */
const FORMAL_NOUNS = new Set([
  'こと', 'もの', 'の', 'ところ', 'とき', 'ため', 'わけ', 'はず', 'つもり', 'ほう', 'うち', 'まま',
]);

/**
 * 补助动词/接尾动词：pos_detail_1 为「接尾」的动词基本是 れる/られる/せる/させる 这类，
 * 本身是语法成分，不是要学的词。
 */
const isSuffixVerb = (t) => t.pos === '動詞' && t.pos_detail_1 === '接尾';

/** 平假名区间 */
const HIRA_RE = /^[\u3041-\u3096\u30FC]+$/;

/** 片假名 → 平假名 */
export function kataToHira(s) {
  if (!s) return '';
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c >= 0x30a1 && c <= 0x30f6) out += String.fromCodePoint(c - 0x60);
    else if (c === 0x30fc) out += '\u30fc'; // 长音符保留
    else out += ch;
  }
  return out;
}

/** 这个读音是不是「真正可用于基本形」的（排除 null / 星号 / 与表面形相同且含汉字的情况） */
function usableReading(reading) {
  if (!reading || reading === '*' || reading === '') return false;
  return true;
}

/**
 * 把 kuromoji 的 token 流变成词条。
 * @param {Array} tokens kuromoji.tokenize() 的结果
 * @param {object} opts { minLen=1, sampleLimit=3, frag }
 */
export function collectJa(tokens, opts = {}) {
  const minLen = Math.max(1, Number(opts.minLen ?? 1));
  const frag = opts.frag ?? null;
  const sampleLimit = Number(opts.sampleLimit ?? 3);

  const out = [];
  let i = 0;
  let offset = 0;
  // 预先算好每个 token 在原文里的 UTF-16 偏移（半开区间）
  const spans = [];
  for (const t of tokens) {
    const surface = t.surface_form ?? '';
    spans.push({ token: t, start: offset, end: offset + surface.length });
    offset += surface.length;
  }

  while (i < tokens.length) {
    const t = tokens[i];
    const surface = t.surface_form ?? '';
    const pos = posFromJa(t.pos, t.pos_detail_1);

    if (SKIP_POS.has(pos) || !surface) { i += 1; continue; }
    // 接尾动词（れる/られる/せる/させる）是语法成分，不单独成词
    if (isSuffixVerb(t)) { i += 1; continue; }
    // 形式名词（こと/もの/の/ところ…）没有词汇意义
    if (t.pos === '名詞' && t.pos_detail_1 === '非自立' && FORMAL_NOUNS.has(surface)) { i += 1; continue; }

    let entry = {
      surface,
      basic: t.basic_form && t.basic_form !== '*' ? t.basic_form : surface,
      readingRaw: t.reading ?? null,
      pos,
      posDetail: [t.pos, t.pos_detail_1 !== '*' ? t.pos_detail_1 : '', t.pos_detail_2 !== '*' ? t.pos_detail_2 : '']
        .filter(Boolean).join('-'),
      unknown: !t.basic_form || t.basic_form === '*',
      start: spans[i].start,
      end: spans[i].end,
      merged: false,
    };

    // サ変名詞 + する：只有「紧邻」才合并，不跨标点、不跨字幕边界
    // （tokens 本来就是同一个片段内切出来的，跨字幕天然不可能跨）
    if (t.pos === '名詞' && t.pos_detail_1 === 'サ変接続' && tokens[i + 1]) {
      const n = tokens[i + 1];
      const isSuru = n.pos === '動詞'
        && (n.conjugated_type === 'サ変・スル' || n.basic_form === 'する')
        && SURU_FORMS.has(n.surface_form);
      if (isSuru) {
        const nounReading = usableReading(t.reading) ? t.reading : '';
        // 拼原形读音不能直接用「し」(シ) 或「さ」(サ) 的读音，
        // 必须用助动词「する」本身的原形读音 スル。
        // 这一步由 index.js 注入的 suruReading 提供（从词典查「する」得到）。
        const suruReading = opts.suruReading ?? '';
        entry = {
          ...entry,
          surface: surface + (n.surface_form ?? ''),
          basic: `${t.basic_form && t.basic_form !== '*' ? t.basic_form : surface}する`,
          pos: 'v.',
          posDetail: `${t.pos_detail_1}+する`,
          unknown: false,
          end: spans[i + 1].end,
          merged: true,
          // 合并词读音 = 名词读音 + する原形读音。两段都是词典给的，属于拼装不是编造。
          mergedReading: nounReading && suruReading ? nounReading + suruReading : '',
        };
        i += 2;
        out.push(entry);
        continue;
      }
    }

    i += 1;
    out.push(entry);
  }

  return out.filter((e) => {
    const len = [...e.surface].length;
    return len >= minLen;
  }).map((e) => {
    const surfaceReading = usableReading(e.readingRaw) ? e.readingRaw : '';
    // 原形读音三级回退：
    //   1. 合并词（勉強する）：名词读音 + する读音（都是词典给的，属于拼装）
    //   2. 表面形 == 基本形：直接用表面形读音
    //   3. 合并词拿不到 → 留空；否则留空交给上层用「基本形本身」去查
    let lemmaReading = '';
    let lemmaSource = 'dictionary';
    if (e.merged) {
      lemmaReading = e.mergedReading || '';
      if (!lemmaReading) lemmaSource = 'compound';
    } else if (!e.unknown && e.surface === e.basic) {
      lemmaReading = surfaceReading;
    }
    return {
      surface: e.surface,
      word: e.basic,
      display: e.basic,
      reading: lemmaReading,
      readingHiragana: lemmaReading ? kataToHira(lemmaReading) : '',
      pos: e.pos,
      posDetail: e.posDetail,
      unknown: e.unknown,
      lemmaSource: e.unknown ? 'surface' : lemmaSource,
      merged: e.merged,
      start: e.start,
      end: e.end,
      sampleText: frag ? frag.text : '',
      t: frag && Number.isFinite(frag.t) ? frag.t : undefined,
      src: frag ? frag.src : '',
    };
  });
}
