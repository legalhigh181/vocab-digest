/**
 * 日文文本清洗 —— 带「原文偏移区间映射」的版本。
 *
 * ## 为什么需要映射
 *
 * kuromoji 只能吃「清洗过、NFKC 归一过」的文本。但用户看到的例句必须是
 * **原始字幕**，点时间点也要能对回原句。而清洗会做三件改变长度的事：
 *   - NFKC：`ｶﾞ`(2) → `ガ`(1) 变短；`㍿`(1) → `株式会社`(4) 变长
 *   - 删除字符（URL、话题标签、零宽、HTML 标签）
 *   - 压缩重复字符（`ｗｗｗｗ` → `ｗｗ`）
 *
 * ## 为什么不能只记「起点」
 *
 * 用户明确要求：**长度相同不代表字符来源范围相同**。
 *   - `ｶﾞ`(2 字) → `ガ`(1 字)：`ガ` 的来源是原文 `[0, 2)` —— 两个字符合成的
 *   - `㍿`(1 字) → `株式会社`(4 字)：`株 式 会 社` 四个字的来源都是原文 `[0, 1)`
 *
 * 只记起点（`[0,0)` 或 `[0) `）无法表达「这个字符吃掉了两个原文单元」，
 * 反推例句区间时就会把 `ガ` 算成只有 `ｶ` 一个字符，丢掉浊点。
 *
 * 所以这里记录 **成对的区间**：
 *   `starts[i]` = 分析文本第 i 个字符覆盖的原文起点
 *   `ends[i]`   = 分析文本第 i 个字符覆盖的原文终点（不含）
 *
 * ## 换算规则
 *
 * 分析文本的 `[s, e)` 换算成原文：
 *   `origStart = starts[s]`
 *   `origEnd   = max(ends[i]) for i in [s, e)`
 *
 * 这样 `ｶﾞ` 的 `ガ` 一定映射回 `[0,2)`，`surfaceOriginal` 才能取到完整的 `ｶﾞ`。
 */
import { toHalfWidth } from '../util.js';

const URL_RE = /https?:\/\/\S+|www\.\S+/gi;
const BVID_RE = /BV[0-9A-Za-z]{10}/g;
const MENTION_RE = /@[\w\u3040-\u30ff\u4e00-\u9fa5_-]{1,20}/g;
const HASHTAG_RE = /[#＃]\s*[^#＃\s]{1,20}\s*[#＃]?/g;
const HTML_TAG_RE = /<[^>]*>/g;
const ZERO_WIDTH_RE = /[\u200b-\u200f\u202a-\u202e\ufeff]/g;
const NOTE_MARKS_RE = /[\u2669\u266a\u266b\u266c]+/g;

const KEEP_RE = /[\u3041-\u3096\u30A1-\u30FA\u30FC\u30FD\u30FE\u3400-\u4DBF\u4E00-\u9FFF\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A0-9A-Za-z\u3005\u30F6]/;
const JA_CHAR_RE = /[\u3041-\u3096\u30A1-\u30FA\u30FC\u3400-\u4DBF\u4E00-\u9FFF]/;

export function squashRepeatsJa(s) {
  return s
    .replace(/(.)\1{3,}/gu, '$1$1')
    .replace(/([!?！？♪…]){3,}/gu, '$1$1');
}

/** 一个「带区间映射的字符序列」 */
function makeSeq(text) {
  // 按 UTF-16 单元切分：代理对（emoji）各占两格，但每格都指向自己的原文下标
  const chars = [];
  const starts = [];
  const ends = [];
  for (let i = 0; i < text.length; i += 1) {
    chars.push(text[i]);
    starts.push(i);
    ends.push(i + 1);
  }
  return { chars, starts, ends };
}

/**
 * 在带映射的字符序列上删除若干区间（区间坐标按「字符序列下标」给）。
 */
function removeSpans(seq, spans) {
  if (!spans.length) return seq;
  const drop = new Uint8Array(seq.chars.length);
  for (const [a, b] of spans) for (let i = a; i < b; i += 1) drop[i] = 1;
  const chars = [];
  const starts = [];
  const ends = [];
  for (let i = 0; i < seq.chars.length; i += 1) {
    if (drop[i]) continue;
    chars.push(seq.chars[i]);
    starts.push(seq.starts[i]);
    ends.push(seq.ends[i]);
  }
  return { chars, starts, ends };
}

function findSpans(re, text) {
  const spans = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    spans.push([m.index, m.index + m[0].length]);
    if (m[0].length === 0) re.lastIndex += 1;
  }
  return spans;
}

/**
 * 把原串切成「归一单位」——**这是精确映射的关键**。
 *
 * 不能对整串做一次 NFKC 再反推（那样任何分段都能拼出整串，映射无解），
 * 也不能逐字符做（`ｶ` + `ﾞ` 会拆开，浊点丢失）。
 *
 * 规则（按优先级）：
 *   1. **基字符 + 组合记号**：一个基字符紧跟 U+3099（浊点）/ U+309A（半浊点）
 *      时合成一段 —— `か` + `゙` → `が`。组合记号不能丢，否则映射会被切断。
 *   2. **半角片假名 + 半角浊点/半浊点**：`ｶ` + `ﾞ` → `ガ`（两个码位合成一个字符）。
 *      ⚠️ **长音符 `ｰ`(U+FF70) 不参与**：它是一音拍，本身就可以当一个独立音，
 *      强行并入前一个假名会让 `ｺｰ` 的来源变成一段而不是两段。
 *      `ｺｰ` → `コ`[0,1) + `ー`[1,2)，整词才是 `[0,2)`。
 *   3. **ASCII** 每字符一段。
 *   4. 其余（汉字、全角假名、兼容字符如 ㍿）每码点一段。
 *
 * 逐单位归一后拼起来必须等于整串 `raw.normalize('NFKC')`，这一点在
 * `normalizeUnitsCompose()` 里断言；不等就退回整串单段（映射退化为整句）。
 */
function normalizeUnits(src) {
  const units = []; // [start, end)
  let i = 0;
  while (i < src.length) {
    const cp = src.codePointAt(i);
    const w = cp > 0xffff ? 2 : 1;

    // 1) 基字符 + 组合记号（浊点/半浊点）：必须一起归一
    if (i + w < src.length) {
      const next = src.charCodeAt(i + w);
      if (next === 0x3099 || next === 0x309a) {
        units.push([i, i + w + 1]);
        i += w + 1;
        continue;
      }
    }

    // 2) 半角片假名 + 半角浊点/半浊点（不含长音符 FF70）
    if (cp >= 0xff66 && cp <= 0xff9d) {
      let j = i + w;
      while (j < src.length) {
        const c2 = src.charCodeAt(j);
        if (c2 === 0xff9e || c2 === 0xff9f) {
          j += 1;
          continue;
        }
        break;
      }
      units.push([i, j]);
      i = j;
      continue;
    }

    // 3) ASCII
    if (cp < 0x80) {
      units.push([i, i + w]);
      i += w;
      continue;
    }

    // 4) 其余每码点一段（含 ㍿、长音符、汉字）
    units.push([i, i + w]);
    i += w;
  }
  return units;
}

/**
 * NFKC 规范化，同时维护区间映射。
 *
 * 逐「归一单位」做 NFKC：每个单位独立归一，覆盖的原文区间就是这个单位本身。
 *   `ｶﾞ` → `ガ`：一单位两码位，`ガ` 覆盖 `[0,2)`
 *   `ｺｰ` → `コ` `ー`：两单位，分别覆盖 `[0,1)` `[1,2)`，整词才是 `[0,2)`
 *   `か` + `゙` → `が`：一单位，`が` 覆盖 `[0,2)`
 *   `㍿` → `株式会社`：一单位一码位，四个字都覆盖 `[0,1)`
 *
 * @returns {{chars:string[], starts:number[], ends:number[], exact:boolean}}
 *   exact=false 表示逐单位拼不回整串归一结果，映射已退化为整句范围
 */
function normalizeSeq(seq) {
  const src = seq.chars.join('');
  const dst = src.normalize('NFKC');
  if (dst === src) return { ...seq, exact: true };

  const units = normalizeUnits(src);

  // 逐单位归一拼起来必须等于整串归一结果
  let joined = '';
  for (const [a, b] of units) joined += src.slice(a, b).normalize('NFKC');

  if (joined !== dst) {
    // 退回「整串一个单位」：映射退化为整句范围，调用方应据此降级展示
    const chars = [];
    const starts = [];
    const ends = [];
    const oStart = seq.starts[0] ?? 0;
    const oEnd = seq.ends[seq.ends.length - 1] ?? 0;
    for (let k = 0; k < dst.length; k += 1) {
      chars.push(dst[k]);
      starts.push(oStart);
      ends.push(oEnd);
    }
    return { chars, starts, ends, exact: false };
  }

  const chars = [];
  const starts = [];
  const ends = [];
  for (const [a, b] of units) {
    const norm = src.slice(a, b).normalize('NFKC');
    const oStart = seq.starts[a];
    const oEnd = seq.ends[b - 1];
    for (let k = 0; k < norm.length; k += 1) {
      chars.push(norm[k]);
      starts.push(oStart);
      ends.push(oEnd);
    }
  }
  return { chars, starts, ends, exact: true };
}

/**
 * 压缩重复字符，同时维护映射（保留的字符各自记住自己覆盖的原文区间）。
 */
function squashSeq(seq) {
  const chars = [];
  const starts = [];
  const ends = [];
  let i = 0;
  while (i < seq.chars.length) {
    const ch = seq.chars[i];
    let j = i;
    while (j < seq.chars.length && seq.chars[j] === ch) j += 1;
    const runLen = j - i;
    const isPunct = /[!?！？♪…]/.test(ch);
    const keep = (isPunct && runLen >= 3) || (!isPunct && runLen >= 4) ? 2 : runLen;
    for (let k = 0; k < keep; k += 1) {
      chars.push(ch);
      starts.push(seq.starts[i + k]);
      ends.push(seq.ends[i + k]);
    }
    i = j;
  }
  return { chars, starts, ends };
}

/**
 * 清洗一条日文文本，并返回「分析文本 → 原文」的**区间**映射。
 *
 * @param {string} raw 原始字幕/弹幕文本
 * @param {object} opts
 * @returns {{
 *   clean: string,
 *   starts: number[],  // starts[i] = 分析文本第 i 个字符覆盖的原文起点
 *   ends: number[],    // ends[i]   = 分析文本第 i 个字符覆盖的原文终点（不含）
 *   map: number[],     // 兼容旧接口：等于 starts
 *   dropped: boolean,
 *   reason?: string
 * }}
 */
export function cleanJapaneseWithMap(raw, opts = {}) {
  const input = String(raw ?? '');
  let seq = makeSeq(input);

  // 1) 删除类规则
  const text0 = seq.chars.join('');
  seq = removeSpans(
    seq,
    [].concat(
      findSpans(HTML_TAG_RE, text0),
      findSpans(URL_RE, text0),
      findSpans(BVID_RE, text0),
      findSpans(MENTION_RE, text0),
      findSpans(HASHTAG_RE, text0),
      findSpans(ZERO_WIDTH_RE, text0),
      findSpans(NOTE_MARKS_RE, text0),
    ),
  );

  // 2) NFKC（可能改变字符数，且变化方向不一定）
  seq = normalizeSeq(seq);
  const exact = seq.exact !== false;

  // 3) 压缩重复
  seq = squashSeq(seq);

  // 4) 白名单过滤：保留可切词的字符，其余变空格
  //
  // ⚠️ 组合记号（U+3099 浊点 / U+309A 半浊点）：
  //   - 有预组字符时（`か`+`゙` → `が`）NFKC 已经合成，这里不会见到记号；
  //   - **没有预组字符时**（`か`+`゚` → 仍两码位，`か゚` 是另一个假名）记号必须保留，
  //     否则 `か゚` 会变成 `か`，语义就变了。
  //   所以组合记号跟着基字符一起保留，并把覆盖区间并进去。
  const chars = [];
  const starts = [];
  const ends = [];
  const COMBINING_RE = /[\u3099\u309a]/;
  for (let i = 0; i < seq.chars.length; i += 1) {
    const ch = seq.chars[i];
    if (COMBINING_RE.test(ch)) {
      // 有前一字符就跟着它（区间合并）；没有就当空格处理
      if (chars.length && chars[chars.length - 1] !== ' ') {
        chars.push(ch);
        starts.push(seq.starts[i]);
        ends.push(seq.ends[i]);
        // 前一字符的区间延伸到记号末尾，保证基字符单独取时也覆盖记号
        const k = chars.length - 2;
        if (k >= 0 && seq.ends[i] > ends[k]) ends[k] = seq.ends[i];
        continue;
      }
    }
    if (KEEP_RE.test(ch)) {
      chars.push(ch);
      starts.push(seq.starts[i]);
      ends.push(seq.ends[i]);
    } else {
      if (chars.length && chars[chars.length - 1] === ' ') continue;
      chars.push(' ');
      starts.push(seq.starts[i]);
      ends.push(seq.ends[i]);
    }
  }
  // 去掉首尾空格
  let a = 0;
  let b = chars.length;
  while (a < b && chars[a] === ' ') a += 1;
  while (b > a && chars[b - 1] === ' ') b -= 1;

  const clean = chars.slice(a, b).join('');
  const mStarts = starts.slice(a, b);
  const mEnds = ends.slice(a, b);

  const out = { clean, starts: mStarts, ends: mEnds, map: mStarts, exact, dropped: false };
  if (!clean) return { ...out, dropped: true, reason: 'no-japanese' };
  if (!JA_CHAR_RE.test(clean)) return { ...out, dropped: true, reason: 'no-japanese' };
  if (opts.stageDirections !== false) {
    const meaningful = clean.replace(/[\s0-9A-Za-z]/g, '');
    if (!meaningful) return { ...out, dropped: true, reason: 'stage-direction' };
  }
  return out;
}

/**
 * 把一个「分析文本区间」换算成原文区间。
 *
 * @param {{starts:number[], ends:number[]}} m 映射
 * @param {number} s 分析文本起始下标（含）
 * @param {number} e 分析文本结束下标（不含）
 * @returns {{start:number, end:number}|null}
 */
export function toOriginalRange(m, s, e) {
  if (!m || !m.starts || s < 0 || e > m.starts.length || e <= s) return null;
  let start = Infinity;
  let end = -Infinity;
  for (let i = s; i < e; i += 1) {
    if (m.starts[i] < start) start = m.starts[i];
    if (m.ends[i] > end) end = m.ends[i];
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { start, end };
}

/**
 * 向后兼容的接口：只要清洗结果，不要映射。
 */
export function cleanJapanese(raw, opts = {}) {
  const r = cleanJapaneseWithMap(raw, opts);
  return { clean: r.clean, dropped: r.dropped, reason: r.reason };
}

const JA_SENTENCE_SPLIT = /(?<=[。！？!?…\n])|(?<=、)/u;

/**
 * 切句，并保留每句在「清洗后文本」里的起始下标。
 * @returns {Array<{text:string, start:number}>}
 */
export function splitSentencesJaWithPos(text) {
  const s = String(text ?? '');
  const out = [];
  let last = 0;
  const parts = s.split(JA_SENTENCE_SPLIT);
  for (const p of parts) {
    const lead = p.length - p.trimStart().length;
    const trimmed = p.trim();
    if (trimmed) out.push({ text: trimmed, start: last + lead });
    last += p.length;
  }
  return out;
}

export function splitSentencesJa(text) {
  return splitSentencesJaWithPos(text).map((p) => p.text);
}

export { toHalfWidth };
