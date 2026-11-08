/**
 * 用户词表导入器：把「词条 → 词性 → 中文释义」这种老式词表文件读成结构化卡片。
 *
 * 实测要处理的格式（用户 LIZ 的两份文件）：
 *   1. 换行是 **单个 \r**（老 Mac 格式），不是 \r\n —— 必须先统一换成 \n 再切行
 *   2. 一个词条可以有多组「词性 → 释义」：
 *        surrender / v. / 投降；… / n. / 投降，自首；…
 *   3. 一行两个词用空格分隔：deception   deceit（解析成两个词条）
 *   4. 短语词条整行保留：whip and strap（不拆成 whip / and / strap）
 *   5. 双空格折叠：be up to  something → be up to something
 *   6. 带连字符的词整词保留：red-handed
 *   7. 大小写归一：Way To Go → way to go
 *   8. 词条重复（vicious 出现两次、内容相同）→ 合并去重
 *   9. 短语表大部分没有词性行，只有「英文行 → 中文行」，第一行如果是英文就当成新词条
 *
 * 输出统一结构（一张卡片 = 一个词条）：
 *   {
 *     word:     'surrender'            // 小写归一，用于索引
 *     display:  'surrender'            // 展示用（保留原始大小写/原貌）
 *     kind:     'word' | 'phrase'      // 含空格 / 连字符以外的多词 → 短语
 *     senses:   [{ pos: 'v.', meaning: '投降；…' }, { pos: 'n.', meaning: '…' }]
 *     scene:    []                     // 场景标签（口语词表/用户手工加）
 *     tags:     []                     // 自由标签
 *     source:   'vocab.txt'            // 导入来源文件名（便于回溯）
 *   }
 */
import { createHash } from 'node:crypto';

/** 词性行的识别：n. v. vt. vi. adj. adv. prep. conj. pron. phr. num. int. aux. art. */
const POS_LINE_RE = /^(?:n|v|vt|vi|adj|adv|prep|conj|pron|phr|num|int|aux|art|abbr)\.$/i;

/** 看起来像英文词条行：至少一个 ASCII 字母，且中文占比很低 */
function looksEnglish(line) {
  if (!/[A-Za-z]/.test(line)) return false;
  const cjk = (line.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  return cjk === 0 || cjk / line.length < 0.2;
}

/** 统一换行：\r\n、单独的 \r、单独的 \n 都变成 \n */
export function normalizeNewlines(text) {
  return String(text).replace(/\r\n?/g, '\n');
}

/** 折叠连续空格，去首尾空白 */
function tidy(s) {
  return String(s).replace(/[ \t\u3000]+/g, ' ').trim();
}

/** 判断是不是短语：含空格，或含连字符但整体仍像一个固定表达 */
function kindOf(word) {
  return /\s/.test(word) ? 'phrase' : 'word';
}

/**
 * 判断一「组」英文行是短语还是单词。
 * 短语表里像 "stumble upon" 这种整行是短语；词汇表里 "deception   deceit" 是两**个单词**。
 * 规则：拆开后每个片段都是合法单词（长度 ≥2、纯字母/连字符/撇号）且片段数 ≤3 → 当成多个单词；
 *       否则（含 the/and/of 这类虚词，或片段超过 3 个）当成一个短语。
 */
const FUNC_WORDS = new Set(['the', 'and', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'a', 'an', 'up', 'out', 'off', 'it', 'be', 'as', 'by', 'or']);
/** 词表里常见的占位符（释义里出现的 sb / sth 说明这是短语补充表达） */
const PLACEHOLDER_RE = /\b(?:sb|sth)\b/i;
/** 介词/冠词开头的行（to do / a cat / in time）明显是短语 */
const LEADING_FUNC_RE = /^(?:a|an|the|to|in|on|at|of|for|with|by|from|into|under|over|about)\b/i;

function splitEntry(englishLine) {
  // 注意：粘性正则 lastIndex 会残留，必须用 String.search 或先重置 —— 否则连续的词条会被误判
  const line = englishLine.trim().replace(/\s+/g, ' ').trim();
  if (!/\s/.test(line)) return [line];
  const parts = line.split(' ').filter(Boolean);
  if (parts.length > 3) return [line];
  const allPlain = parts.every((p) => /^[A-Za-z][A-Za-z'-]*$/.test(p));
  const hasFunc = parts.some((p) => FUNC_WORDS.has(p.toLowerCase()));
  // 一行两个词用【两个以上空格】分隔 = 一行两个词条（deception   deceit）；
  // 单空格分隔（jet lag / red handed）当作短语。
  const doubleSpaced = /[ \t]{2,}/.test(String(englishLine).trim());
  if (parts.length === 2 && allPlain && !hasFunc && doubleSpaced) return parts;
  // 其余（stumble upon / bail on me / jet lag / to do）整行保留成一个短语
  return [line];
}

function makeCard(word, display, senses, meta = {}) {
  const key = tidy(word).toLowerCase();
  return {
    word: key,
    display: tidy(display) || key,
    kind: kindOf(key),
    senses: senses.filter((s) => s.meaning || s.pos),
    scene: meta.scene ?? [],
    tags: meta.tags ?? [],
    source: meta.source ?? '',
  };
}

/**
 * 解析词表文本。
 * @param {string} text 原始文本（任意换行格式）
 * @param {object} opts { source 文件名, defaultScene 默认场景标签 }
 * @returns {{ cards: Array, warnings: Array<{level,message}> }}
 */
export function parseWordListText(text, opts = {}) {
  const source = opts.source ?? 'imported.txt';
  const lines = normalizeNewlines(text).split('\n').map((l) => l.trim()).filter(Boolean);
  const warnings = [];
  const cards = [];

  // 整份文件是「短语表」还是「单词表」：
  // 短语表几乎每张卡都落在短语上；单词表全是单个词。用「含虚词的行占比」判断。
  const englishLines = lines.filter((l) => !POS_LINE_RE.test(l) && looksEnglish(l));
  const spacedLines = englishLines.filter((l) => /\s/.test(l));
  const funcLines = spacedLines.filter((l) => l.split(' ').some((p) => FUNC_WORDS.has(p.toLowerCase())));
  const phraseFile = opts.phraseFile ?? (spacedLines.length >= 2 && funcLines.length / spacedLines.length >= 0.4);

  let cur = null;

  const flush = () => {
    if (!cur) return;
    for (const w of cur.entries) {
      if (!w) continue;
      const card = makeCard(w, w, cur.senses, { source: opts.source, scene: opts.defaultScene });
      cards.push(card);
    }
    cur = null;
  };

  for (const line of lines) {
    if (line.startsWith('#')) continue;
    if (POS_LINE_RE.test(line)) {
      if (!cur) { warnings.push({ level: 'warn', message: `孤立词性行：${line}` }); continue; }
      cur.senses.push({ pos: line.toLowerCase(), meaning: '' });
      cur.last = 'pos';
      continue;
    }
    if (looksEnglish(line)) {
      // 英文行 = 新词条（短语表里大部分词条就是这种「英文行 → 中文行」结构）
      flush();
      cur = { entries: splitEntry(line, { phraseFile }), senses: [], last: 'english' };
      continue;
    }
    // 中文行 = 最近的词性对应的释义；没有词性行就挂到最后一个 sense 上
    if (!cur) { warnings.push({ level: 'warn', message: `开头缺少英文词条：${line.slice(0, 20)}` }); continue; }
    if (cur.last === 'pos' && cur.senses.length) {
      const last = cur.senses[cur.senses.length - 1];
      last.meaning = last.meaning ? `${last.meaning}；${line}` : line;
    } else if (cur.senses.length) {
      const last = cur.senses[cur.senses.length - 1];
      last.meaning = last.meaning ? `${last.meaning}；${line}` : line;
    } else {
      cur.senses.push({ pos: '', meaning: line });
    }
    cur.last = 'meaning';
  }
  flush();

  return { cards: dedupeCards(cards), warnings };
}

/** 合并重复词条：同一个词出现两次时把 senses 里没出现过的补进去 */
export function dedupeCards(cards) {
  const map = new Map();
  for (const c of cards) {
    const prev = map.get(c.word);
    if (!prev) { map.set(c.word, { ...c, senses: [...c.senses] }); continue; }
    for (const s of c.senses) {
      const dup = prev.senses.some((p) => p.pos === s.pos && tidy(p.meaning) === tidy(s.meaning));
      if (!dup) prev.senses.push(s);
    }
    if (c.display && c.display === c.word && prev.display !== prev.word) {
      // 保留第一个有意义的展示名
    }
  }
  return [...map.values()];
}

/** 卡片 → 纯文本（导出/备份时用，格式与导入器兼容） */
export function cardsToText(cards) {
  const out = [];
  for (const c of cards) {
    out.push(c.display || c.word);
    if (!c.senses.length) {
      out.push('');
      continue;
    }
    for (const s of c.senses) {
      if (s.pos) out.push(s.pos);
      if (s.meaning) out.push(s.meaning);
    }
  }
  return `${out.join('\r\n').replace(/\r\n\r\n/g, '\r\n')}\r\n`;
}

/** 卡片集合的指纹：内容变了才需要重建索引 */
export function cardsHash(cards) {
  const h = createHash('sha256');
  for (const c of [...cards].sort((a, b) => (a.word < b.word ? -1 : 1))) {
    h.update(`${c.word}\u0001${c.display}\u0001`);
    for (const s of c.senses) h.update(`${s.pos}\u0002${s.meaning}\u0003`);
    h.update('\u0004');
  }
  return h.digest('hex').slice(0, 16);
}

/** 从卡片里取「这个词的默认词性和释义」（给引擎补 meaning 用） */
export function primarySense(card) {
  if (!card?.senses?.length) return { pos: '', meaning: '' };
  const first = card.senses[0];
  return { pos: first.pos ?? '', meaning: card.senses.map((s) => s.meaning).filter(Boolean).join('；') };
}
