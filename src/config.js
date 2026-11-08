/**
 * 配置加载：内置默认值 ← config.default.json ← config.local.json ← 调用方覆盖。
 *
 * 路径键统一解析成绝对路径；数据文件缺失记入 missingFiles（由 prepareConfig 决定报错还是初始化）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const pkgRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/** 内置默认配置（config.default.json 缺失时的兜底） */
export const BUILTIN_DEFAULTS = {
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
  docx: { titlePrefix: '英语词汇整理', fontCn: '等线', fontEn: 'Calibri', toc: true, samplePerWord: 3, includeBase: false },
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
 * @param {object} opts { cwd, localConfigPath, overrides, dataDirOverride }
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

  // 3. 调用方覆盖
  if (opts.overrides) cfg = deepMerge(cfg, opts.overrides);
  if (opts.dataDirOverride) cfg = deepMerge(cfg, { dataDir: opts.dataDirOverride });

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
  for (const key of ['stopwordFile', 'knownFile', 'baseFile', 'lemmatizeExceptions', 'posFile']) {
    lexicon[key] = track(`lexicon.${key}`, lexPath(key));
  }
  // 口语词表可选：缺失不算错（用户可能不想用），只是少了一层释义补充
  lexicon.colloquialFile = lexPath('colloquialFile') || '';
  lexicon.freqRankFile = lexRaw.freqRankFile ? track('lexicon.freqRankFile', lexPath('freqRankFile')) : '';

  return {
    ...cfg,
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
