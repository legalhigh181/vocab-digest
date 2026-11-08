/**
 * 短语（词组）抽取：2~4 词的固定搭配/惯用表达，如 "neural network" / "look up to" / "jet lag"。
 *
 * v2 相比 v1 的改动（v1 用「滑动窗口 + 纯频次」，产出一堆 doctor comes / now don't 这类句子碎片）：
 *   1. PMI（点互信息）：搭配必须显著高于随机共现
 *   2. 边界熵：短语两侧的邻词要足够分散（固定搭配不会总接同一个词）
 *   3. 缩略语闸门：含 what' / it' 这类残片的窗口一律不进短语
 *   4. 实词锚定 + 边界虚词闸门：短语两端不能是纯功能词，且必须含至少一个正式实词
 *   5. 口语短语白名单：data/colloquial.json 登记的短语无条件保留
 *   6. 子串合并：低频短搭配被高频长搭配包含时只留长的
 *
 * 全部是确定性规则，同一个输入永远得到同一个输出。
 */
import { cleanFragmentText, splitSentences } from './clean.js';
import { tokenize } from './tokenize.js';

const LOG2 = Math.log(2);

/** 短语里允许出现的缩略形式（这些是真实短语的一部分） */
const OK_APOSTROPHE = new Set([
  "don't", "doesn't", "didn't", "isn't", "aren't", "wasn't", "weren't", "can't",
  "couldn't", "won't", "wouldn't", "shouldn't", "haven't", "hasn't", "hadn't",
  "what's", "it's", "that's", "i'm", "i've", "i'd", "i'll", "you're", "we're",
  "they're", "let's", "there's", "here's", "who's", "how's",
]);

/** 拆分残片：以撇号结尾且不在白名单（what' / it' / nothing'） */
function isBrokenApostrophe(w) {
  if (!w.includes("'")) return false;
  if (OK_APOSTROPHE.has(w)) return false;
  return /'$/.test(w);
}

/** 香农熵（自然对数） */
function entropy(seq) {
  const total = seq.length;
  if (!total) return 0;
  const freq = new Map();
  for (const s of seq) freq.set(s, (freq.get(s) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / total;
    h -= p * Math.log(p);
  }
  return h;
}

/**
 * 二元组 PMI：log2( P(x,y) / (P(x)P(y)) )，概率用总 token 数归一化。
 * 返回值越大，「这两个词绑在一起」越不像巧合。
 */
function pmiOf(a, b, uni, bi, total) {
  if (!total) return 0;
  const cxy = bi.get(`${a} ${b}`) ?? 0;
  if (!cxy) return 0;
  const cx = uni.get(a) ?? 0;
  const cy = uni.get(b) ?? 0;
  if (!cx || !cy) return 0;
  return Math.log((cxy * total) / (cx * cy)) / LOG2;
}

/**
 * @param {Array} fragments
 * @param {object} opts
 *   { minN=2, maxN=4, minCount=2, stopwords:Set, samplePerWord=2, lemmatize:Function,
 *     minPmi=3, minEntropy=0.8, whitelist:Map, minContentN=2 }
 * @returns {{ phrases: Array, dropped: object }}
 */
export function extractPhrases(fragments, opts = {}) {
  const {
    minN = 2,
    maxN = 4,
    minCount = 2,
    stopwords = new Set(),
    samplePerWord = 2,
    lemmatize = (w) => w,
    minPmi = 3,
    minEntropy = 0.8,
    /** 口语短语白名单：Map<key, {meaning, scene, display}>，命中无条件保留 */
    whitelist = new Map(),
    /** 短语成立的最低实词数 */
    minContentN = 2,
  } = opts;

  /** 功能词：停用词，或本身是缩略形式（don't / it's / i'm） */
  const isFunc = (w) => stopwords.has(w) || (w.includes("'") && OK_APOSTROPHE.has(w));
  /** 正式实词：非功能词、长度 ≥3、不含撇号（doctor / feel / runny） */
  const isSolid = (w) => w.length >= 3 && !isFunc(w) && !w.includes("'");

  const whitelisted = new Set();
  for (const k of whitelist.keys()) whitelisted.add(String(k).toLowerCase().replace(/\s+/g, ' '));

  /** 两遍扫描：第一遍只统计 unigram / bigram，第二遍才切窗口 */
  const unigram = new Map();
  const bigram = new Map();
  let total = 0;
  const units = [];

  for (const frag of fragments) {
    const { clean } = cleanFragmentText(frag.text);
    if (!clean) continue;
    for (const sentence of splitSentences(clean)) {
      const toks = tokenize(sentence, { minLen: 2 }).map((t) => t.lower);
      if (!toks.length) continue;
      units.push({ toks, text: clean, src: frag.src, t: frag.t });
      total += toks.length;
      for (let i = 0; i < toks.length; i += 1) {
        unigram.set(toks[i], (unigram.get(toks[i]) ?? 0) + 1);
        if (i + 1 < toks.length) {
          const key = `${toks[i]} ${toks[i + 1]}`;
          bigram.set(key, (bigram.get(key) ?? 0) + 1);
        }
      }
    }
  }

  /** key → { words, count, sources, samples, firstT, lefts, rights } */
  const table = new Map();

  for (const u of units) {
    const { toks } = u;
    if (toks.length < minN) continue;
    for (let n = minN; n <= maxN; n += 1) {
      for (let i = 0; i + n <= toks.length; i += 1) {
        const win = toks.slice(i, i + n);
        // 边界虚词闸门：短语不能以纯功能词开头/结尾（now don't feel well / doctor comes）
        if (isFunc(win[0]) || isFunc(win[n - 1])) continue;
        if (win.some(isBrokenApostrophe)) continue;
        // 实词数量：2 词要求至少 1 个正式实词，3~4 词要求至少 2 个
        const solidN = win.filter(isSolid).length;
        if (solidN < (n >= 3 ? minContentN : 1)) continue;

        const key = win.join(' ');
        let ent = table.get(key);
        if (!ent) {
          ent = { words: win, key, count: 0, sources: {}, samples: [], firstT: undefined, lefts: [], rights: [] };
          table.set(key, ent);
        }
        ent.count += 1;
        ent.sources[u.src] = (ent.sources[u.src] ?? 0) + 1;
        if (ent.firstT === undefined && Number.isFinite(u.t)) ent.firstT = u.t;
        if (ent.samples.length < samplePerWord) ent.samples.push({ text: u.text, src: u.src, t: u.t });
        ent.lefts.push(i > 0 ? toks[i - 1] : '#');
        ent.rights.push(i + n < toks.length ? toks[i + n] : '#');
      }
    }
  }

  const entries = [...table.values()].filter((e) => e.count >= minCount);

  /** 短语的最小 PMI：多词短语取所有相邻二元组的最小值 */
  const phrasePmi = (words) => {
    let min = Infinity;
    for (let i = 0; i + 1 < words.length; i += 1) {
      min = Math.min(min, pmiOf(words[i], words[i + 1], unigram, bigram, total));
    }
    return min === Infinity ? 0 : min;
  };

  const pad = (key) => ` ${key} `;
  const phrases = [];
  const dropped = {
    raw: table.size,
    lowCount: table.size - entries.length,
    lowPmi: 0,
    lowEntropy: 0,
    redundant: 0,
    kept: 0,
  };

  for (const e of entries) {
    const isWhite = whitelisted.has(e.key);
    // 窗口占满整句时边界熵恒为 0，不能当「不可独立使用」的证据（minEntropy: 0 即关闭该门槛）
    const hasContext = e.lefts.some((x) => x !== '#') || e.rights.some((x) => x !== '#');
    if (!isWhite) {
      const pmi = phrasePmi(e.words);
      // 3 词以上的窗口容易出现「高频组合 + 噪声」，要求更严格
      const pmiGate = e.words.length >= 3 ? minPmi * 1.2 : minPmi;
      if (pmi < pmiGate) { dropped.lowPmi += 1; continue; }
      // 只出现 2 次时边界熵不可靠（可能只是同一句话重复），不参与判断
      if (e.count >= 3 && hasContext) {
        const hLeft = entropy(e.lefts);
        const hRight = entropy(e.rights);
        if (hLeft < minEntropy && hRight < minEntropy) { dropped.lowEntropy += 1; continue; }
      }
    }

    const needle = pad(e.key);
    const redundant = entries.some(
      (o) => o.words.length > e.words.length && o.count >= e.count && pad(o.key).includes(needle),
    );
    if (redundant) { dropped.redundant += 1; continue; }

    // lemmaKey：每个词单独还原再拼（修掉 v1 里 what' wrong 这种残缺）
    const lemmas = e.words.map((w) => {
      try { return lemmatize(w) || w; } catch { return w; }
    });
    const white = whitelist.get(e.key);
    phrases.push({
      word: e.key,
      display: white?.display ?? e.key,
      lemmaKey: lemmas.join(' '),
      count: e.count,
      sources: e.sources,
      samples: e.samples,
      firstT: e.firstT,
      forms: { [e.key]: e.count },
      shout: 0,
      scene: white?.scene ?? [],
      fromList: Boolean(white),
      pmi: Number(phrasePmi(e.words).toFixed(2)),
    });
  }

  // 稳定排序：白名单优先 → 频次降序 → 词长降序 → 字典序
  phrases.sort((a, b) => {
    if (a.fromList !== b.fromList) return a.fromList ? -1 : 1;
    if (b.count !== a.count) return b.count - a.count;
    if (b.word.length !== a.word.length) return b.word.length - a.word.length;
    return a.word < b.word ? -1 : a.word > b.word ? 1 : 0;
  });
  dropped.kept = phrases.length;
  return { phrases, dropped };
}
