/**
 * 配置加载：内置默认值 ← config.default.json ← config.local.json ← 调用方覆盖。
 *
 * 路径键统一解析成绝对路径；数据文件缺失记入 missingFiles（由 prepareConfig 决定报错还是初始化）。
 *
 * 语言覆盖顺序（务必保持）：内置默认 → config.default.json → config.local.json →
 * **语言默认值**（只补用户没显式给的那些键）→ 调用方覆盖。
 * 这样旧配置里写死的英文 minLen=3 不会无条件盖住日语的 minLen=1。
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGUAGE_DEFAULTS, normalizeLanguage, usesEnglishLexicon } from './languages/index.js';

export const pkgRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/** 内置默认配置（config.default.json 缺失时的兜底） */
export const BUILTIN_DEFAULTS = {
  language: 'en',
  runRoot: 'runs',
  outDir: 'out',
  dataDir: 'data',
  input: { formats: ['json', 'xml', 'srt', 'vtt', 'ass', 'txt'] },
  lexicon: {
    minLen: 3,
    minFreq: 1,
    maxDanmakuPerSec: 20,
    stopwordFile: 'data/stopword.txt',
    knownFile: 'data/known/known.txt',
    baseFile: 'data/base/base.txt',
    lemmatizeExceptions: 'data/lemmatize.exceptions.json',
    posFile: 'data/pos.json',
    colloquialFile: 'data/colloquial.json',
    excludeRegex: '',
  },
  classify: { by: ['pos'], byPos: true, bySource: false, unknownBatchSize: 40 },
  // fontCn 故意不设默认值：它的语言无关默认值只对英文成立（等线在日文系统上不存在），
  // 真正的默认值由 src/docx/build.js 的 LANGUAGE_DOC_DEFAULTS 按语言给。用户显式配置仍优先。
  // titlePrefix 同理：写死「英语词汇整理」会让日文文档顶着英文标题，这里不能有默认值。
  docx: { fontEn: 'Calibri', toc: true, samplePerWord: 3, includeBase: false },
  source: {
    bilibili: { enabled: false, cookie: '', minDelayMs: 800, maxDelayMs: 1500, maxRetry: 3 },
  },
};

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function deepMerge(base, extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return extra === undefined ? base : extra;
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object'
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}

function abs(from, p) {
  if (!p) return '';
  return isAbsolute(p) ? p : resolve(from, p);
}

/**
 * 解析配置。
 * @param {object} opts { cwd, localConfigPath, overrides, dataDirOverride, language }
 */
export function resolveConfig(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  let cfg = { ...BUILTIN_DEFAULTS };

  // 1. 随包 config.default.json
  const pkgDefault = join(pkgRoot, 'config.default.json');
  if (existsSync(pkgDefault)) {
    try { cfg = deepMerge(cfg, readJson(pkgDefault)); } catch { /* 坏文件退回内置 */ }
  }

  // 2. 本机 config.local.json
  const localPath = opts.localConfigPath ? abs(cwd, opts.localConfigPath) : join(pkgRoot, 'config.local.json');
  const loadedLocal = existsSync(localPath) ? localPath : '';
  if (loadedLocal) cfg = deepMerge(cfg, readJson(loadedLocal));

  // 记录「用户真正显式写过哪些键」：只有这里的键才不许被语言默认值覆盖。
  // 随包 config.default.json 里的 minLen=3 是英文默认值，不是用户的选择，
  // 若拿它当用户配置，日语永远拿不到 minLen=1。
  // 存成普通对象而不是 Map —— deepMerge 里 Object.entries 对 Map 只会得到空数组。
  const userLocal = loadedLocal ? readJson(loadedLocal) : {};
  const userExplicitLex = {};
  for (const [k, v] of Object.entries(userLocal?.lexicon ?? {})) userExplicitLex[k] = v;
  if (opts.overrides?.lexicon) {
    for (const [k, v] of Object.entries(opts.overrides.lexicon)) userExplicitLex[k] = v;
  }

  // 3. 先定语言（调用方显式参数 > 配置文件），再应用该语言的默认值
  const language = normalizeLanguage(opts.language ?? cfg.language);
  const langDefaults = LANGUAGE_DEFAULTS[language] ?? {};
  const langLex = {};
  for (const [k, v] of Object.entries(langDefaults)) {
    if (!(k in userExplicitLex)) langLex[k] = v;
  }
  if (Object.keys(langLex).length) cfg = deepMerge(cfg, { lexicon: langLex });
  cfg = { ...cfg, language };

  // 4. 调用方覆盖（最优先）
  if (opts.dataDirOverride) cfg = deepMerge(cfg, { dataDir: opts.dataDirOverride });
  if (opts.overrides) cfg = deepMerge(cfg, opts.overrides);
  // 语言默认值与用户显式值的最终裁决：用户写过的一律以用户为准
  for (const k of Object.keys(userExplicitLex)) {
    if (cfg.lexicon && k in cfg.lexicon) cfg = { ...cfg, lexicon: { ...cfg.lexicon, [k]: userExplicitLex[k] } };
  }
  // 覆盖之后语言可能被 overrides 改过，再归一一次并回写
  const finalLanguage = normalizeLanguage(opts.language ?? cfg.language);
  cfg = { ...cfg, language: finalLanguage };

  const dataDir = abs(cwd, cfg.dataDir);

  // 词表路径：显式配置的绝对路径优先；默认的 `data/...` 相对 dataDir 解析
  const lexRaw = cfg.lexicon ?? {};
  const lexPath = (key) => {
    const p = lexRaw[key];
    if (!p) return '';
    if (isAbsolute(p)) return p;
    if (p.startsWith('data/')) return join(dataDir, p.slice('data/'.length));
    return resolve(cwd, p);
  };

  const missingFiles = [];
  const track = (label, p) => {
    const full = p ? abs(cwd, p) : '';
    if (!full || !existsSync(full)) missingFiles.push({ key: label, path: full || '(未配置)' });
    return full;
  };

  const lexicon = { ...lexRaw };
  // 英语要那一整套词表；日语只用 stopword + known，绝不要求英文文件齐全
  const requiredKeys = usesEnglishLexicon(finalLanguage)
    ? ['stopwordFile', 'knownFile', 'baseFile', 'lemmatizeExceptions', 'posFile']
    : ['stopwordFile', 'knownFile'];
  for (const key of requiredKeys) {
    lexicon[key] = track(`lexicon.${key}`, lexPath(key));
  }
  for (const key of ['stopwordFile', 'knownFile', 'baseFile', 'lemmatizeExceptions', 'posFile']) {
    if (!requiredKeys.includes(key)) lexicon[key] = lexPath(key) || '';
  }
  // 口语词表可选：缺失不算错（用户可能不想用），只是少了一层释义补充
  lexicon.colloquialFile = lexPath('colloquialFile') || '';
  lexicon.freqRankFile = lexRaw.freqRankFile ? track('lexicon.freqRankFile', lexPath('freqRankFile')) : '';

  return {
    ...cfg,
    language: finalLanguage,
    cwd,
    pkgRoot,
    localConfigPath: loadedLocal,
    runRoot: abs(cwd, cfg.runRoot),
    outDir: abs(cwd, cfg.outDir),
    dataDir,
    lexicon,
    missingFiles,
    /** 数据文件是否齐全（缺文件时不静默用空表） */
    dataOk: missingFiles.length === 0,
  };
}

export { deepMerge };
