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
import { normalizeJaEntryKey } from '../ja/entrykey.js';

/**
 * 词性行识别：n. v. vt. vi. adj. adv. prep. conj. pron. phr. num. int. aux. art. abbr. prop.
 *
 * ⚠️ 必须包含 `prop.`（专有名词）：词性映射会把「固有名詞」映射成 `prop.`，
 * 它一旦漏在词性表外面，导出再导入时会被当成英文词条，把整张卡拆坏。
 */
const POS_LINE_RE = /^(?:n|v|vt|vi|adj|adv|prep|conj|pron|phr|num|int|aux|art|abbr|prop|part|sym|filler|affix)\.$/i;

/** 看起来像英文词条行：至少一个 ASCII 字母，且中日文占比很低 */
function looksEnglish(line) {
  if (!/[A-Za-z]/.test(line)) return false;
  const cjk = (line.match(/[\u3040-\u30ff\u4e00-\u9fa5]/g) ?? []).length;
  return cjk === 0 || cjk / line.length < 0.2;
}

/**
 * 看起来像**日文词条**行：含假名或汉字，且不是纯中文释义。
 * 日文词条（`日本`）在 looksEnglish 眼里是 false（没有 ASCII 字母），
 * 必须单独识别，否则会被当成释义行吃掉上一个词条。
 */
function looksJapanese(line) {
  if (!/[\u3040-\u30ff\u4e00-\u9fa5]/.test(line)) return false;
  // 太长的行基本是中文释义，不是词条
  if (line.length > 20) return false;
  // 以全角标点结尾的更像释义
  if (/[。！？；，、]$/.test(line)) return false;
  return true;
}

/** 统一换行：\r\n、单独的 \r、单独的 \n 都变成 \n */
export function normalizeNewlines(text) {
  return String(text).replace(/\r\n?/g, '\n');
}

/** 折叠连续空格，去首尾空白 */
function tidy(s) {
  return String(s).replace(/[ \t\u3000]+/g, ' ').trim();
}

/**
 * 这一行是不是「新词条行」。
 *
 * 英文词表沿用原来的「看起来像英文」判定；
 * 日文词表额外允许「纯假名/汉字」开新词条 —— 否则 `日本` 会被当成释义行，
 * 把上一个词条吃掉。日文表的判断更严：必须是短的、不以句末标点结尾的实体行。
 */
function isEntryLine(line, cur, japaneseTable) {
  if (looksEnglish(line)) return true;
  if (!japaneseTable) return false;
  if (!looksJapanese(line)) return false;
  // 日文表里：当前块还没有任何释义 → 这行是词条
  if (!cur) return true;
  if (!cur.senses.some((s) => s.meaning)) return false;
  // 当前块已经有释义了，又来一个短日文行 → 新词条
  return true;
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
  const raw = tidy(word);
  // ⚠️ 只有英文才小写归一。日文（以及任何非英文表）必须保留原样：
  // 小写会毁掉 `Vtuber` / `iPhone` / `USBメモリ`，也会让 entryKey 里的词形对不上，
  // 往返一次就再也匹配不上原来的卡片。
  const japanese = meta.language === 'ja' || meta.japanese === true;
  const key = japanese ? raw : raw.toLowerCase();
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
/**
 * `#ja` 元信息行里 entryKey 的还原（`cardsToText` 的逆操作）。
 *
 * 写出去时把**每个** `|` 和 `\` 都加了反斜杠；还原必须**单遍扫描**：
 * 连着做 `.replace(/\\\\/g,'\\')` 再 `.replace(/\\\|/g,'|')` 会把
 * 「词形里本来就有的 `\|`」压成 `|`，转义信息就丢了。
 */
function unescapeKeyText(s) {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '\\' && (s[i + 1] === '\\' || s[i + 1] === '|')) {
      out += s[i + 1];
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

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

  // 这份文件里有没有日文元信息行 —— 有就按日文表处理（词条行可以是纯汉字/假名）
  const japaneseTable = opts.japanese === true || lines.some((l) => l.startsWith('#ja'));

  let cur = null;
  /** 下一张卡片要带上的元信息（来自 #ja 行） */
  let pendingMeta = null;

  const flush = () => {
    if (!cur) return;
    for (const w of cur.entries) {
      if (!w) continue;
      const card = makeCard(w, w, cur.senses, {
        source: opts.source,
        scene: opts.defaultScene,
        // 日文表：词形保持原样，不小写
        language: cur.meta?.language,
        japanese: japaneseTable,
      });
      // 保留 #ja 元信息行带来的字段
      if (cur.meta) Object.assign(card, cur.meta);
      cards.push(card);
    }
    cur = null;
  };

  for (const line of lines) {
    if (line.startsWith('#')) {
      // `#ja <entryKey> 读音：… 词性：… 假名：… 未知：1` —— 日文卡片的元信息行。
      //
      // **位置约定：元信息行写在它所属卡片的前面**（即「词条 / 词性 / 释义」之前）。
      // 理由：导入时一张卡是在遇到下一条词条行时才 flush 的，元信息行在前才能挂上；
      // 如果写在后面，就已经被 flush 成一张卡了。
      const m = /^#ja\s+(\S*)\s*(.*)$/.exec(line);
      if (m) {
        const meta = { language: 'ja' };
        if (m[1] && m[1] !== '-') {
          meta.entryKey = normalizeJaEntryKey(unescapeKeyText(m[1]));
        }
        const rd = /读音[:：]\s*(\S+)/.exec(m[2]);
        if (rd) meta.reading = rd[1];
        const ps = /词性[:：]\s*(\S+)/.exec(m[2]);
        if (ps) meta.pos = ps[1];
        const pd = /词性细节[:：]\s*(\S+)/.exec(m[2]);
        if (pd) meta.posDetail = pd[1];
        const kn = /假名[:：]\s*(\S+)/.exec(m[2]);
        if (kn) meta.readingHiragana = kn[1];
        if (/未知[:：]\s*1/.test(m[2])) {
          meta.unknown = true;
          meta.lemmaSource = 'surface';
        }
        // 挂到「下一张」卡片：先存 pending，flush 时合并
        pendingMeta = { ...(pendingMeta ?? {}), ...meta };
      }
      continue;
    }
    if (POS_LINE_RE.test(line)) {
      if (!cur) { warnings.push({ level: 'warn', message: `孤立词性行：${line}` }); continue; }
      cur.senses.push({ pos: line.toLowerCase(), meaning: '' });
      cur.last = 'pos';
      continue;
    }
    if (isEntryLine(line, cur, japaneseTable)) {
      // 词条行 = 新卡片（单词表是纯英文，日文表可以是纯汉字/假名）
      flush();
      cur = {
        entries: japaneseTable && !looksEnglish(line) ? [line] : splitEntry(line, { phraseFile }),
        senses: [],
        last: 'english',
        meta: pendingMeta ?? undefined,
      };
      pendingMeta = null;
      continue;
    }
    // 释义行 = 最近的词性对应的释义；没有词性行就挂到最后一个 sense 上
    if (!cur) { warnings.push({ level: 'warn', message: `开头缺少词条：${line.slice(0, 20)}` }); continue; }
    if (cur.senses.length) {
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

/**
 * 合并重复词条。
 *
 * ⚠️ 有 entryKey 的卡片（日文）必须按 **entryKey** 去重，不能按裸 word：
 * `日本#ニホン` 和 `日本#ニッポン` 是两个不同的词，按 word 去重会把它们并成一条，
 * 释义也会被拼成「日本（にほん）；日本（にっぽん）」。
 */
export function dedupeCards(cards) {
  const map = new Map();
  for (const c of cards) {
    const key = c.entryKey || c.word;
    const prev = map.get(key);
    if (!prev) { map.set(key, { ...c, senses: [...c.senses] }); continue; }
    for (const s of c.senses) {
      const dup = prev.senses.some((p) => p.pos === s.pos && tidy(p.meaning) === tidy(s.meaning));
      if (!dup) prev.senses.push(s);
    }
    // 补齐缺失的元信息（同一个 entryKey 才会走到这里，不会串项）
    for (const f of ['entryKey', 'reading', 'readingHiragana', 'posDetail', 'lemmaSource', 'language']) {
      if (c[f] && !prev[f]) prev[f] = c[f];
    }
  }
  return [...map.values()];
}

/** 卡片 → 纯文本（导出/备份时用，格式与导入器兼容） */
export function cardsToText(cards) {
  const out = [];
  for (const c of cards) {
    // 元信息行放在整张卡片**之前**（#ja → 词条 → 词性 → 释义）。
    // 导入时一张卡是在遇到下一条词条行时才收尾的，元信息行在前才能挂到这张卡上。
    if (c.language === 'ja' && (c.entryKey || c.reading)) {
      const parts = [
        c.reading ? `读音：${c.reading}` : '',
        c.pos ? `词性：${c.pos}` : '',
        c.posDetail ? `词性细节：${c.posDetail}` : '',
        c.readingHiragana ? `假名：${c.readingHiragana}` : '',
        c.unknown ? '未知：1' : '',
      ].filter(Boolean);
      // entryKey 里的 | 需要转义，避免和分隔符混淆
      const key = String(c.entryKey ?? '-').replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
      out.push(`#ja ${key} ${parts.join(' ')}`.trim());
    }
    out.push(c.display || c.word);
    if (c.senses.length) {
      for (const s of c.senses) {
        if (s.pos) out.push(s.pos);
        if (s.meaning) out.push(s.meaning);
      }
    }
  }
  return `${out.join('\r\n')}\r\n`;
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
