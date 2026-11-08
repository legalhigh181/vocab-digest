/**
 * 用法（usages）：把「这个词/短语在视频里怎么用的」整理成可读条目。
 *
 * 一条 usage 长这样：
 *   {
 *     text:     原句（清洗后）              "Now I don't feel well."
 *     t:        视频时间点（秒）             123.4
 *     src:      来自哪个文件                 "BV1xxx.srt"
 *     skeleton: 句法骨架（命中的词换成 ___） "Now I ___."
 *     word:     命中的词形                   "feel"
 *     kind:     'word' | 'phrase'
 *   }
 *
 * 设计要点：
 *   - 同一个句子里出现两次同样的词只记一条（去重按 text+word）
 *   - 骨架用原文大小写保留，方便给用户看「原话怎么说的」
 *   - 最多保留 N 条（默认 5），不足时补原文句子（没有命中的句子不放）
 */
import { cleanFragmentText, splitSentences } from './clean.js';

/** 默认展示条数 */
export const DEFAULT_USAGE_LIMIT = 5;

/** 大小写不敏感地找出词/短语在原句里的所有出现位置 */
function findSpans(sentence, target) {
  const spans = [];
  const hay = sentence.toLowerCase();
  const needle = target.toLowerCase();
  if (!needle) return spans;
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i < 0) break;
    // 词边界检查：避免 feel 命中 feeling / feel-good 中间
    const before = i === 0 ? '' : hay[i - 1];
    const after = hay[i + needle.length] ?? '';
    const okBefore = !before || !/[a-z0-9']/.test(before);
    const okAfter = !after || !/[a-z0-9']/.test(after);
    if (okBefore && okAfter) spans.push({ start: i, end: i + needle.length });
    from = i + needle.length;
  }
  return spans;
}

/** 用 ___ 替换命中位置，得到句法骨架 */
function skeletonOf(sentence, spans) {
  if (!spans.length) return sentence;
  let out = '';
  let cursor = 0;
  for (const s of spans) {
    out += sentence.slice(cursor, s.start) + '___';
    cursor = s.end;
  }
  out += sentence.slice(cursor);
  return out.replace(/\s+/g, ' ').trim();
}

/** 一个片段里所有句子的 usage 列表（尚未去重、未限制条数） */
function usagesOfFragment(frag, target, kind) {
  const { clean } = cleanFragmentText(frag.text);
  if (!clean) return [];
  const out = [];
  for (const sentence of splitSentences(clean)) {
    const spans = findSpans(sentence, target);
    if (!spans.length) continue;
    out.push({
      text: sentence,
      t: Number.isFinite(frag.t) ? frag.t : undefined,
      src: frag.src,
      skeleton: skeletonOf(sentence, spans),
      word: target,
      kind,
    });
  }
  return out;
}

/**
 * 收集一个词/短语的用法条目。
 * @param {Array} fragments 全部片段
 * @param {string} target 词（原形）或短语原文
 * @param {object} opts { limit=5, forms={} 该词的所有表面形式, kind='word' }
 */
export function collectUsages(fragments, target, opts = {}) {
  const { limit = DEFAULT_USAGE_LIMIT, forms = {}, kind = 'word' } = opts;
  // 关键词 = 原形 + 所有表面形式（feeling / feels / felt 都算 feel 的用法）
  const needles = new Set([target, ...Object.keys(forms ?? {})].map((w) => String(w).toLowerCase()));
  const seen = new Set();
  const out = [];

  for (const frag of fragments) {
    if (out.length >= limit) break;
    const { clean } = cleanFragmentText(frag.text);
    if (!clean) continue;
    for (const sentence of splitSentences(clean)) {
      if (out.length >= limit) break;
      const lower = sentence.toLowerCase();
      let hit = '';
      for (const n of needles) {
        if (findSpans(lower, n).length) { hit = n; break; }
      }
      if (!hit) continue;
      const key = `${hit}\u0000${sentence}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const spans = findSpans(sentence, hit);
      out.push({
        text: sentence,
        t: Number.isFinite(frag.t) ? frag.t : undefined,
        src: frag.src,
        skeleton: skeletonOf(sentence, spans),
        word: hit,
        kind,
      });
    }
  }
  return out;
}

/** 短语版本：直接用原文匹配（短语本身含空格，不需要 forms） */
export function collectPhraseUsages(fragments, phrase, opts = {}) {
  const { limit = DEFAULT_USAGE_LIMIT } = opts;
  const out = [];
  const seen = new Set();
  for (const frag of fragments) {
    if (out.length >= limit) break;
    for (const u of usagesOfFragment(frag, phrase, 'phrase')) {
      const key = `${u.word}\u0000${u.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(u);
      if (out.length >= limit) break;
    }
  }
  return out;
}
