/**
 * 分类：给每个词打标签（词性标签 + 来源标签 + 难度标签）。
 *
 * 词性判定优先级：
 *   1. POS 表（data/pos.json，用户可自己维护：{"word": "n."}）
 *   2. decisions.json（人工/翻译回写的判定）
 *   3. 首字母大写 → prop.（专有名词）
 *   4. 形态启发式（-tion/-ment → n.、-ful/-ous → adj.、-ly → adv.）
 *   5. 兜底 other
 */

/** 词性排序：文档章节按此顺序出现 */
export const POS_ORDER = ['n.', 'v.', 'adj.', 'adv.', 'phr.', 'prop.', 'num.', 'other'];

export const POS_ZH = {
  'n.': '名词',
  'v.': '动词',
  'vt.': '及物动词',
  'vi.': '不及物动词',
  'adj.': '形容词',
  'adv.': '副词',
  'phr.': '短语',
  'prop.': '专有名词',
  'pron.': '代词',
  'prep.': '介词',
  'conj.': '连词',
  'det.': '限定词',
  'int.': '感叹词',
  'aux.': '助动词',
  'art.': '冠词',
  'num.': '数词',
  num: '数词',
  other: '其他',
};

export function posLabel(pos) {
  return POS_ZH[pos] ?? POS_ZH.other;
}

const ADV_SUFFIX = /(?:ly|wards?|wise)$/;
const ADJ_SUFFIX = /(?:ful|ous|ive|able|ible|al|ic|less|ary|ent|ant|ish|like)$/;
// 注意：不能用 er|or 结尾判名词（doctor / teacher 是名词，但同时 gradient / different 会被误判）；
// 也不能让 adv 抢在 adj 前面（-ly 开头的是少数）。细则见 heuristicPos。
const NOUN_SUFFIX = /(?:tion|sion|ment|ness|ity|ance|ence|ship|hood|ism|ist|age|ure|dom)$/;
/** 动词后缀：词长门槛更高，避免 grant / planet 这类短词被吃进来 */
const VERB_SUFFIX = /(?:ize|ise|ify|ate)$/;

/** 明确的 -en 结尾动词（不是所有 -en 都是动词：garden / chicken / token 都不是） */
const EN_VERBS = new Set([
  'listen', 'happen', 'open', 'written', 'broken', 'spoken', 'taken', 'given', 'driven', 'known',
  'shown', 'grown', 'thrown', 'chosen', 'frozen', 'stolen', 'hidden', 'beaten', 'eaten', 'fallen',
  'forgotten', 'shaken', 'awaken', 'strengthen', 'widen', 'sharpen', 'worsen', 'lighten', 'deepen',
]);

/** 名词词尾的常见「非名词」反例：判成 -er/-or 名词之前先排除这些 */
const NOT_NOUN_TAIL = /(?:ther|ther|ber|der|ver|per|ger|ter|her|wer)$/;

/**
 * 形态启发式：只处理明显能判的，判不了给 null。
 * 关键取舍：判错不如不判 —— 判成 other（未标注）比判成错误词性更诚实。
 */
export function heuristicPos(word) {
  const w = String(word).toLowerCase();
  if (w.length < 4) return null;
  // -ly：gentlely 这种拼错不存在，但 costly/homely 是形容词，先放过
  if (ADV_SUFFIX.test(w) && w.length > 5 && !/(?:cost|home|love|friend|order|time)ly$/.test(w)) return 'adv.';
  // -ly：gentlely 这种拼错不存在，但 costly/homely 是形容词，先放过
  if (ADV_SUFFIX.test(w) && w.length > 5 && !/(?:cost|home|love|friend|order|time)ly$/.test(w)) return 'adv.';
  // 明确的名词后缀先判：commitment 不能因为 -ent 被当成形容词
  if (NOUN_SUFFIX.test(w) && w.length > 5) return 'n.';
  if (ADJ_SUFFIX.test(w) && w.length > 4) return 'adj.';
  // -er/-or：只在明显是「施动者」（8 字母以上、且不像形容词比较级）时判名词
  if (/(?:er|or)$/.test(w) && w.length >= 8 && !NOT_NOUN_TAIL.test(w)) return 'n.';
  if ((VERB_SUFFIX.test(w) && w.length > 5) || EN_VERBS.has(w)) return 'v.';
  return null;
}

/**
 * 构建分类器。
 * @param {object} opts { pos:object, decisions:object, base:Set }
 */
export function createClassifier(opts = {}) {
  const pos = opts.pos ?? {};
  const decisions = opts.decisions ?? {};
  const base = opts.base ?? new Set();

  return function classify(word, count = 1, isShout = false) {
    const w = String(word ?? '').toLowerCase();
    const dec = decisions[w];
    const posFromDecision = typeof dec === 'string' ? dec : dec?.pos;

    let p = pos[w] ?? posFromDecision ?? (isShout ? 'prop.' : null) ?? heuristicPos(w) ?? 'other';

    if (!POS_ORDER.includes(p)) p = 'other';
    const isBase = base.has(w);
    return { pos: p, base: isBase, section: p };
  };
}

/** 按词性分组：返回 [{ key, label, items }]，空组不出现 */
export function groupByPos(items) {
  const buckets = new Map(POS_ORDER.map((p) => [p, []]));
  for (const it of items) {
    const p = POS_ORDER.includes(it.pos) ? it.pos : 'other';
    buckets.get(p).push(it);
  }
  const out = [];
  for (const p of POS_ORDER) {
    const list = buckets.get(p);
    if (!list.length) continue;
    list.sort(sortItems);
    out.push({ key: p, label: `词性 · ${posLabel(p)}（${list.length}）`, items: list });
  }
  return out;
}

/** 按来源文件分组：返回 [{ key, label, items }] */
export function groupBySource(items) {
  const buckets = new Map();
  for (const it of items) {
    const srcs = Object.keys(it.sources ?? {});
    if (!srcs.length) srcs.push('(未知来源)');
    for (const s of srcs) {
      if (!buckets.has(s)) buckets.set(s, []);
      buckets.get(s).push(it);
    }
  }
  const out = [];
  for (const s of [...buckets.keys()].sort()) {
    const list = buckets.get(s);
    list.sort(sortItems);
    out.push({ key: `src:${s}`, label: `来源 · ${s}（${list.length}）`, items: list });
  }
  return out;
}

/** 稳定排序：频次降序 → 词长降序 → 字典序 */
export function sortItems(a, b) {
  if (b.count !== a.count) return b.count - a.count;
  if (b.word.length !== a.word.length) return b.word.length - a.word.length;
  return a.word < b.word ? -1 : a.word > b.word ? 1 : 0;
}

// ───────────────────────────────────────────────────────────────────────────
// 多维度标签（m00186：文档内按标签分章，阅读时按标签切换查看类型）
// ───────────────────────────────────────────────────────────────────────────

/** 可切换的标签维度，按文档章节出现顺序排列 */
export const TAG_DIMENSIONS = ['pos', 'difficulty', 'source', 'freq'];

export const TAG_DIM_LABELS = {
  pos: '词性',
  difficulty: '难度',
  source: '来源',
  freq: '频次',
};

/**
 * 难度标签：
 *   basic   基础词（命中 data/base/base.txt）
 *   unknown 未标注（词性判为 other，多半是没在词表里的生词）
 *   其余    advanced（非基础词）
 */
export function difficultyTag(it) {
  if (it.base) return 'basic';
  if (it.pos === 'other') return 'unknown';
  return 'advanced';
}

export const DIFFICULTY_LABELS = { basic: '基础词', advanced: '进阶词', unknown: '未标注' };

/** 频次档：按出现次数分档，档位上限由调用方给出（默认 1/2-4/5+） */
export function freqBand(count) {
  if (count >= 5) return 'often';
  if (count >= 2) return 'several';
  return 'once';
}

export const FREQ_BAND_LABELS = { often: '高频（≥5 次）', several: '中频（2-4 次）', once: '低频（1 次）' };

/** 给一个词条打上全部维度的标签，返回 { pos, difficulty, source[], freq } */
export function tagsOf(it) {
  return {
    pos: it.pos ?? 'other',
    difficulty: difficultyTag(it),
    source: Object.keys(it.sources ?? {}).length ? Object.keys(it.sources ?? {}) : ['(未知来源)'],
    freq: freqBand(it.count ?? 1),
  };
}

/**
 * 按某个维度分章。
 * @param {Array} items 词条
 * @param {'pos'|'difficulty'|'source'|'freq'} dim
 * @returns {Array<{key,label,items}>}
 */
export function groupByTag(items, dim) {
  const buckets = new Map();
  const push = (key, it) => {
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(it);
  };
  for (const it of items) {
    const t = tagsOf(it);
    if (dim === 'source') for (const s of t.source) push(s, it);
    else push(t[dim], it);
  }

  const order = {
    pos: POS_ORDER,
    difficulty: ['basic', 'advanced', 'unknown'],
    freq: ['often', 'several', 'once'],
    source: [...buckets.keys()].sort(),
  }[dim] ?? [...buckets.keys()];

  const label = (key) => {
    if (dim === 'pos') return posLabel(key);
    if (dim === 'difficulty') return DIFFICULTY_LABELS[key] ?? key;
    if (dim === 'freq') return FREQ_BAND_LABELS[key] ?? key;
    return key;
  };

  const out = [];
  for (const key of order) {
    const list = buckets.get(key);
    if (!list || !list.length) continue;
    list.sort(sortItems);
    const prefix = TAG_DIM_LABELS[dim] ?? dim;
    out.push({ key: `tag:${dim}:${key}`, tagKey: key, label: `${prefix} · ${label(key)}（${list.length}）`, items: list });
  }
  return out;
}

/** 标签总览：{ pos: [{key,label,count}], ... }，用于文档开头「标签索引」和按标签筛选 */
export function tagSummary(items) {
  const out = {};
  for (const dim of TAG_DIMENSIONS) {
    out[dim] = groupByTag(items, dim).map((g) => ({ key: g.tagKey, label: g.label, count: g.items.length }));
  }
  return out;
}
