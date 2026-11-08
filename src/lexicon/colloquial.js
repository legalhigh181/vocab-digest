/**
 * 口语词表：data/colloquial.json。
 *
 * 结构（按标签分组，方便人工维护）：
 * {
 *   "words": {
 *     "nurse": { "pos": "n.", "meaning": "护士", "scene": ["看病"] },
 *     "stuff": { "pos": "n.", "meaning": "东西（口语）", "scene": ["日常"] }
 *   },
 *   "phrases": {
 *     "nothing serious": { "pos": "phr.", "meaning": "没什么大不了的", "scene": ["看病"] }
 *   }
 * }
 *
 * 作用：
 *   - 词：补词性（免得被启发式判成 other）、补中文释义、给场景标签
 *   - 短语：作为 extractPhrases 的白名单，命中无条件保留
 *   - 两个集合里的词都进「词典」，这样 nurses 才能被还原成 nurse
 *
 * 用户自己加词：直接改 data/colloquial.json（不会被程序覆盖），或在应用里点「加入词库」。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 一次性把各种形态（对象/数组/纯文本）都读成 {word → {pos, meaning, scene}} */
function normalizeWordEntry(word, v) {
  const key = String(word).trim().toLowerCase().replace(/\s+/g, ' ');
  if (!key) return null;
  if (typeof v === 'string') return { key, pos: '', meaning: v, scene: [] };
  if (Array.isArray(v)) return { key, pos: '', meaning: v.join('；'), scene: [] };
  if (v && typeof v === 'object') {
    return {
      key,
      pos: String(v.pos ?? ''),
      meaning: String(v.meaning ?? ''),
      scene: Array.isArray(v.scene) ? v.scene.map(String) : (v.scene ? [String(v.scene)] : []),
    };
  }
  return { key, pos: '', meaning: '', scene: [] };
}

/**
 * 加载口语词表。
 * @param {string} file colloquial.json 路径
 * @returns {{ words: Map, phrases: Map, missing: boolean, path: string }}
 */
export function loadColloquial(file) {
  const words = new Map();
  const phrases = new Map();
  if (!file || !existsSync(file)) return { words, phrases, missing: true, path: file ?? '' };

  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { words, phrases, missing: false, path: file, broken: true };
  }

  for (const [k, v] of Object.entries(raw.words ?? {})) {
    const e = normalizeWordEntry(k, v);
    if (e) words.set(e.key, e);
  }
  for (const [k, v] of Object.entries(raw.phrases ?? {})) {
    const e = normalizeWordEntry(k, v);
    if (e) phrases.set(e.key, { ...e, display: v?.display ?? e.key });
  }
  return { words, phrases, missing: false, path: file };
}

/** 把口语词表追加进 data/known.txt（用户点「加入词库」时调用） */
export function colloquialDefaultPath(dataDir) {
  return join(dataDir, 'colloquial.json');
}
