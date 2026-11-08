/**
 * 候选抽取：token → lemma → 频次 / 上下文 / 首现时间。
 *
 * 输入：fragments（原始片段）
 * 输出：{ candidates: Map<lemma, Candidate>, dropped: {...}, secondsSeen: number }
 *
 * Candidate = {
 *   word, display,            // 原形；展示形式（保留 CPU / Drive 这类写法）
 *   count,                    // 出现次数
 *   sources: { [src]: count },
 *   firstT,                   // 首次出现的秒（可能 undefined）
 *   forms: { [form]: count }, // 见过的原始形态（看复数 / 时态用）
 *   samples: [{ text, src, t }],
 *   shout: number,            // 疑似全大写刷屏次数
 * }
 */
import { cleanFragmentText } from './clean.js';
import { splitCompound, splitContraction, tokenize } from './tokenize.js';

/** 展示形式打分：全大写缩写 > 首字母大写 > 小写 */
function displayScore(w) {
  if (/^[A-Z0-9]{2,}$/.test(w)) return 3;
  if (/^[A-Z][a-z]/.test(w)) return 2;
  return 1;
}

/** 人名头衔缩写：字幕里出现基本是「Dr. Brown」这种人名，不是要学的词 */
const ABBREV = new Set(['dr', 'mr', 'mrs', 'ms', 'st', 'jr', 'sr', 'etc', 'vs', 'eg', 'ie']);

/**
 * "s" 缩略中其实是「所有格 / has」的代词：what's / it's / nothing's / let's / that's。
 * 这些不能拼回 "whats"，要落回原代词。
 */
const CLITIC_S = new Set([
  'it', 'that', 'what', 'who', 'here', 'there', 'he', 'she', 'where', 'how', 'let',
  'nothing', 'something', 'everything', 'anything', 'everybody', 'somebody', 'nobody',
  'anybody', 'this', 'when', 'why', 'one', 'today', 'everyone', 'someone',
]);

function addCandidate(map, lemma, display, frag, sampleMax, form, shout) {
  let cand = map.get(lemma);
  if (!cand) {
    cand = {
      word: lemma,
      // 小写化后的展示形式：字幕每句开头都大写，不能让 "Music" 盖过 "music"
      display: display.toLowerCase(),
      count: 0,
      sources: {},
      forms: {},
      samples: [],
      shout: 0,
      firstT: Number.isFinite(frag.t) ? frag.t : undefined,
    };
    map.set(lemma, cand);
  }
  cand.count += 1;
  cand.sources[frag.src] = (cand.sources[frag.src] ?? 0) + 1;
  const f = form ?? display.toLowerCase();
  cand.forms[f] = (cand.forms[f] ?? 0) + 1;
  if (shout) cand.shout += 1;
  if (cand.firstT === undefined && Number.isFinite(frag.t)) cand.firstT = frag.t;
  // 展示形式：默认就是 lemma（小写）；只有全大写缩写（GPU / NASA）才保留原写法
  if (/^[A-Z0-9]{3,}$/.test(display) && /[A-Z]{2}/.test(display)) cand.display = display;
  pushSample(cand, { text: frag.text, src: frag.src, t: frag.t }, sampleMax);
}

/** 确定性取样：优先不同来源，同分取先出现的 */
function pushSample(cand, sample, max) {
  if (cand.samples.length < max) { cand.samples.push(sample); return; }
  const hasSrc = cand.samples.some((s) => s.src === sample.src);
  if (!hasSrc) {
    for (let i = 0; i < cand.samples.length; i += 1) {
      const s = cand.samples[i];
      if (cand.samples.filter((x) => x.src === s.src).length > 1) { cand.samples[i] = sample; return; }
    }
  }
}

/**
 * @param {Array} fragments
 * @param {object} opts { minLen, samplePerWord, lemmatize, extraStop, dropShout }
 */
export function extractCandidates(fragments, opts = {}) {
  const {
    minLen = 3,
    samplePerWord = 3,
    lemmatize = (w) => w,
    extraStop = new Set(),
    dropShout = true,
    dictionary = new Set(),
  } = opts;

  const candidates = new Map();
  const dropped = { nonLatin: 0, short: 0, stop: 0, shout: 0, empty: 0 };
  const seen = new Set();

  for (const frag of fragments) {
    const { clean, dropped: noLatin } = cleanFragmentText(frag.text);
    if (!clean) { dropped.empty += 1; continue; }
    if (noLatin) { dropped.nonLatin += 1; continue; }

    const tokens = tokenize(clean, { minLen });
    if (!tokens.length) { dropped.short += 1; continue; }

    for (const tok of tokens) {
      // 驼峰 / 连字符拆词
      const parts = splitCompound(tok.raw);
      if (parts.length > 1) {
        for (const p of parts) {
          if (p.length < minLen) continue;
          if (dropShout && /^[A-Z]{2,}$/.test(p)) { dropped.shout += 1; continue; }
          addCandidate(candidates, p.toLowerCase(), p, frag, samplePerWord, undefined, false);
        }
        continue;
      }

      let form = tok.lower;
      if (dropShout && tok.isShout) {
        if (form.length <= 4) { dropped.shout += 1; continue; }
        // 长一点的全大写（GPU / NASA）：只有同批次已出现过该词的小写形态才并入
        const seenLower = candidates.get(form) ?? candidates.get(String(lemmatize(form) || form));
        const lowerOnly = seenLower && Object.keys(seenLower.forms).some((f) => f !== form);
        if (lowerOnly) {
          addCandidate(candidates, seenLower.word, tok.raw, frag, samplePerWord, form, false);
        } else {
          dropped.shout += 1;
        }
        continue;
      }

      // 缩略语：don't → do（只取词干）；但「词干+s」的缩略不能丢，
      // 否则 what's → what、it's → it、let's → let、nothing's → nothing 这批高频词全没了
      const c = splitContraction(form);
      if (c) {
        const full = c.stem + c.suffix;
        if (c.suffix === 's' && CLITIC_S.has(c.stem)) form = c.stem;
        else if (c.suffix === 's') form = full;
        else if (c.suffix === 't') form = c.stem.replace(/n$/, '');
        else form = c.stem;
      }
      if (!form || form.length < minLen) { dropped.short += 1; continue; }

      // 缩写（Dr. / Mr. / e.g.）在字幕里几乎都指人名，不是生词
      if (ABBREV.has(form)) { dropped.stop += 1; continue; }

      if (extraStop.has(form)) { dropped.stop += 1; continue; }

      let lemma = form;
      try { lemma = lemmatize(form) || form; } catch { lemma = form; }
      // 词表里的词：能还原到词表原形就用词表原形（commitments → commitment），
      // 还原不到但词表里直接有这个词面，也用它（hearts → heart）
      if (!lemma || lemma.length < 2) continue;
      if (dictionary.size) {
        if (dictionary.has(lemma)) {
          // 已经在原形上，不用动
        } else if (dictionary.has(form)) {
          lemma = form;
        }
      }
      if (extraStop.has(lemma)) { dropped.stop += 1; continue; }

      // 展示形式用清洗后的形态（nothing），不要用原 token（Nothing's）
      addCandidate(candidates, lemma, form, frag, samplePerWord, form, false);
    }
    if (Number.isFinite(frag.t)) seen.add(frag.t);
  }

  return { candidates, dropped, secondsSeen: seen.size };
}
