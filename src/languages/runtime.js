/**
 * 语言运行时准备（T1）。
 *
 * 目前只有英文适配器真正的抽词逻辑在 pipeline 里（历史上就是同步的，行为必须逐字节不变）。
 * 这里先只负责：
 *   1. 按语言初始化词表目录（data/ 与 data/ja/ 分开）
 *   2. 校验该语言需要的文件是否存在
 *   3. 登记一个「就绪」标记，供同步流程检查
 *
 * 日语分析器在 T3 接入 `src/languages/ja.js`，那时只需在这里多一次 await。
 */
import { existsSync } from 'node:fs';
import { ensureData } from '../data/seed.js';
import {
  getRuntime, normalizeLanguage, registerRuntime, usesEnglishLexicon,
} from './index.js';

/** 每种语言需要哪些 lexicon 文件（缺了必须报错，绝不能静默用空表） */
const REQUIRED_FILES = {
  en: ['stopwordFile', 'knownFile', 'baseFile', 'lemmatizeExceptions', 'posFile'],
  ja: ['stopwordFile', 'knownFile'],
};

export const RUNTIME_VERSION = 2;

/**
 * 准备某语言的运行时。进程内按「语言 + 数据目录 + 运行时版本」缓存，重复调用是廉价的。
 *
 * 顺序很重要：**先 ensureData，再在 config 上刷新 missingFiles**。
 * 不刷新会误报「缺少词表文件」—— 文件其实刚刚才建好。
 *
 * @param {object} config resolveConfig 的返回值（必须已带 language / dataDir / lexicon 路径）
 * @param {object} [opts] { initData: false 跳过建目录（测试 / 只读场景）, resolveConfig }
 * @returns {Promise<{language,ready,missing,created,dataDir}>}
 */
export async function prepareLanguageRuntime(config, opts = {}) {
  const language = normalizeLanguage(config.language);
  const dataDir = config.dataDir ?? '';
  const cacheKey = `${language}\u0000${dataDir}\u0000${RUNTIME_VERSION}`;

  const cached = getRuntime(language);
  if (cached && cached.cacheKey === cacheKey) return cached;

  const created = opts.initData === false
    ? []
    : ensureData(dataDir, { language });

  // ensureData 之后重新解析配置，让缺失判断反映磁盘真实状态
  const resolve = opts.resolveConfig ?? config._resolve ?? null;
  const freshLexicon = resolve ? resolve().lexicon : (config.lexicon ?? {});

  const required = REQUIRED_FILES[language] ?? [];
  const missing = required
    .map((key) => ({ key, path: freshLexicon?.[key] ?? '' }))
    .filter((m) => !m.path || !existsSync(m.path));

  const runtime = {
    language,
    ready: missing.length === 0,
    missing,
    created,
    dataDir,
    cacheKey,
    runtimeVersion: RUNTIME_VERSION,
    usesEnglishLexicon: usesEnglishLexicon(language),
  };

  registerRuntime(language, runtime);
  return runtime;
}
