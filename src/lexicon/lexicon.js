/**
 * 词表：停用词 / 已知词 / 基础词 / POS 表 / 词形还原例外。
 *
 * 所有词表都是「一行一词」的纯文本（# 开头为注释），便于用户自己维护。
 * 文件缺失时不静默放行 —— 由 prepareConfig 报错或先 ensureData 生成。
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadColloquial } from './colloquial.js';
import { createLemmatizer } from './lemmatize.js';
import { STEM_WHITELIST } from './stems.js';

/**
 * 读「一行一词」词表。
 * 行内空白也当分隔符：种子词表里 `a an the` 写在同一行，用户手抄时也常见。
 */
export function readWordList(file) {
  if (!file || !existsSync(file)) return null;
  const out = new Set();
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    for (const w of t.split(/[\s,]+/)) {
      const v = w.trim().toLowerCase();
      if (v && !v.startsWith('#')) out.add(v);
    }
  }
  return out;
}

/** 读 JSON 词表；文件损坏时返回 null（走 missing 流程，而不是抛栈） */
export function readJsonFile(file) {
  if (!file || !existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 加载全部词表。
 * @returns {{ stopwords:Set, known:Set, base:Set, pos:object, decisions:object,
 *             freqRank:object, exceptions:object, dictionary:Set, missing:string[], lemmatize:Function }}
 */
export function loadLexicon(config, extra = {}) {
  const lex = config.lexicon ?? {};
  const missing = [];
  const need = (label, file, loader = readWordList) => {
    const v = loader(file);
    if (v === null) missing.push({ key: label, path: file || '(未配置)' });
    return v;
  };

  const stopwords = need('stopwordFile', lex.stopwordFile) ?? new Set();
  const known = need('knownFile', lex.knownFile) ?? new Set();
  const base = need('baseFile', lex.baseFile) ?? new Set();
  const pos = need('posFile', lex.posFile, readJsonFile) ?? {};
  const freqRank = readJsonFile(lex.freqRankFile ?? '') ?? {};
  const exceptions = readJsonFile(lex.lemmatizeExceptions) ?? {};

  // 口语词表是「可选增强」：文件不在也不算缺词表（不能因为用户删了它就报错）
  const colloquial = loadColloquial(lex.colloquialFile);

  // 词典 = 基础词 ∪ POS 表词 ∪ 已知词 ∪ 停用词 ∪ 词根白名单 ∪ 口语词 —— 弱后缀还原只用它验证候选。
  // 停用词必须算进来：teach / push / work 这类高频动词都在 stopword.txt 里，
  // 少了它们 -ing 还原就会造出 *teache* / *worke*。
  // 口语词必须算进来：nurse / nurses 这类词不在 POS 表里，不加就还原不到 nurse。
  const dictionary = new Set([
    ...base,
    ...Object.keys(pos),
    ...known,
    ...stopwords,
    ...STEM_WHITELIST,
    ...colloquial.words.keys(),
    ...colloquial.phrases.keys(),
    ...extra.extraWords ?? [],
  ]);
  const decisions = extra.decisions ? { ...extra.decisions } : {};
  // 用户词表（词表系统）里的释义也要让「高亮」认得出来：只补没有的键，不覆盖已标注的
  const patchDecisions = extra.patchDecisions ?? {};
  for (const [w, v] of Object.entries(patchDecisions)) {
    if (!decisions[w]) decisions[w] = v;
  }

  const lemmatize = createLemmatizer({ dictionary, exceptions });

  return {
    stopwords, known, base, pos, decisions, freqRank, exceptions, dictionary, missing, lemmatize,
    /** 口语词：Map<word, {pos, meaning, scene}> */
    colloquialWords: colloquial.words,
    /** 口语短语白名单：Map<key, {pos, meaning, scene, display}> */
    colloquialPhrases: colloquial.phrases,
    colloquialBroken: Boolean(colloquial.broken),
    colloquialPath: colloquial.path,
  };
}

/** 把词追加进 known.txt（增量维护用户的「已掌握」） */
export function appendKnown(file, words) {
  const list = [...new Set(words.map((w) => String(w).trim().toLowerCase()).filter(Boolean))].sort();
  if (!list.length) return { file, added: 0 };
  mkdirSync(dirname(file), { recursive: true });
  const existing = readWordList(file) ?? new Set();
  const fresh = list.filter((w) => !existing.has(w));
  if (fresh.length) {
    const prefix = existsSync(file) && readFileSync(file, 'utf8').length > 0 ? '\n' : '';
    appendFileSync(file, prefix + fresh.join('\n') + '\n', 'utf8');
  }
  return { file, added: fresh.length };
}

/** 覆盖写已知词表（排序去重，便于 reviewer diff） */
export function writeKnown(file, words) {
  const list = [...new Set(words.map((w) => String(w).trim().toLowerCase()).filter(Boolean))].sort();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${list.join('\n')}\n`, 'utf8');
  return { file, count: list.length };
}
