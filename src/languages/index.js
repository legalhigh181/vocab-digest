/**
 * 语言契约：校验与归一化 `language` 参数。
 *
 * 契约（T1）：
 *   - 顶层 `language: 'en' | 'ja'`，缺省 `en`
 *   - 入口接受 `jp` 作为 `ja` 的别名，但落盘只用 `ja`
 *   - 非法值（含 `true`、数字、未知字符串）一律报 INVALID_LANGUAGE
 *   - 首版不提供 auto
 */

export const LANGUAGES = ['en', 'ja'];

/** 接受的别名 → 规范值。只做精确匹配，绝不子串猜测。 */
const ALIASES = new Map([
  ['en', 'en'],
  ['ja', 'ja'],
  ['jp', 'ja'],
]);

export const DEFAULT_LANGUAGE = 'en';

/**
 * 校验并归一化语言值。
 * @param {unknown} value 原始输入（undefined/null/'' 视为缺省）
 * @returns {'en'|'ja'}
 */
export function normalizeLanguage(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_LANGUAGE;
  if (typeof value !== 'string') {
    const err = new Error(`language 必须是字符串 'en' 或 'ja'，收到 ${typeof value}`);
    err.code = 'INVALID_LANGUAGE';
    err.value = value;
    throw err;
  }
  const key = value.trim().toLowerCase();
  const hit = ALIASES.get(key);
  if (!hit) {
    const err = new Error(`不支持的语言：${value}（只接受 en / ja）`);
    err.code = 'INVALID_LANGUAGE';
    err.value = value;
    throw err;
  }
  return hit;
}

/** 是不是已知语言（不抛错版本，供 UI / 工具判断） */
export function isSupportedLanguage(value) {
  if (typeof value !== 'string') return false;
  return ALIASES.has(value.trim().toLowerCase());
}

/**
 * 各语言的默认词表参数。
 *
 * 日语没有空格，「猫」「手」这种单字实词必须保留，所以 minLen=1；
 * 英语沿用 3 保持既有结果不变。
 *
 * 路径一律显式写 ''（表示「这个语言没有这个文件」）。不能省略键 ——
 * 省略会掉回 config.default.json 里的英文路径，日语就被要求读英文词表。
 */
export const LANGUAGE_DEFAULTS = {
  en: {
    minLen: 3,
    minFreq: 1,
    stopwordFile: 'data/stopword.txt',
    knownFile: 'data/known/known.txt',
    baseFile: 'data/base/base.txt',
    lemmatizeExceptions: 'data/lemmatize.exceptions.json',
    posFile: 'data/pos.json',
    colloquialFile: 'data/colloquial.json',
    freqRankFile: '',
  },
  ja: {
    minLen: 1,
    minFreq: 1,
    // 日语独立词表：不加载英文 exceptions / pos / ECDICT，
    // 也绝不要求英文文件齐全
    stopwordFile: 'data/ja/stopword.txt',
    knownFile: 'data/ja/known.txt',
    baseFile: '',
    lemmatizeExceptions: '',
    posFile: '',
    colloquialFile: '',
    freqRankFile: '',
  },
};

/** 该语言是否需要英文那套词表（ECDICT / pos / 基础词 / 词形例外） */
export function usesEnglishLexicon(language) {
  return normalizeLanguage(language) === 'en';
}

/**
 * 进程内语言运行时登记表。
 *
 * 为什么需要：kuromoji 构建词典分析器是**异步**的，而 `runDigest` / `digest()`
 * 都是同步函数。做法是先 `prepareLanguageRuntime()` 异步准备好适配器，
 * 再让同步流程按语言取用；没准备就同步调用时明确报错，而不是退化成错误的分词。
 */
const RUNTIMES = new Map();

export function registerRuntime(language, runtime) {
  RUNTIMES.set(normalizeLanguage(language), runtime);
}

export function getRuntime(language) {
  return RUNTIMES.get(normalizeLanguage(language)) ?? null;
}

export function clearRuntime(language) {
  if (language === undefined) RUNTIMES.clear();
  else RUNTIMES.delete(normalizeLanguage(language));
}

/** 同步流程里取适配器：没准备好就报 LANGUAGE_RUNTIME_NOT_READY */
export function requireRuntime(language) {
  const lang = normalizeLanguage(language);
  const rt = RUNTIMES.get(lang);
  if (!rt) {
    const err = new Error(`语言运行时尚未初始化：${lang}。请先调用 prepareLanguageRuntime()。`);
    err.code = 'LANGUAGE_RUNTIME_NOT_READY';
    err.language = lang;
    throw err;
  }
  return rt;
}
