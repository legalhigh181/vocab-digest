/**
 * 释义提供者（meaningProvider）—— T4 的核心。
 *
 * ## 为什么需要它
 *
 * 英文有 ECDICT（77 万词的离线英汉词典），日文没有。第一版日文只抽词、
 * 不产出释义，但「词表里能填释义」是用户的刚需，所以需要一层**可插拔的释义来源**。
 *
 * ## 设计
 *
 * 用户明确要求：
 *   - 不能只留一个空接口，必须**至少有一个可用的本地实现**
 *   - 查询要包含 **词形 + 读音 + 词性**（同形异读词不能串项）
 *   - 结果要标明 **释义语言** 和 **来源**
 *   - 未配置 / 查询未命中 / 加载失败 要**分别处理**
 *   - 释义缺失仍可生成词条和 Word，提示**按运行汇总**，不逐词刷屏
 *
 * 本文件提供：
 *   - `MeaningProvider` 约定（duck typing，不强制继承）
 *   - `createFileProvider({file, ...})` —— 本地 JSON / TSV 实现
 *   - `createNoopProvider(reason)` —— 未配置时的空实现
 *   - `resolveMeaning(...)` —— 三层优先级：人工修订 > 当前词表 > provider
 */
import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';

/** provider 约定的形态（仅作文档用，实现不必继承） */
export const MeaningProviderContract = {
  /** @returns {{ok:boolean, meaning:string, meaningLanguage:string, source:string, error?:string}} */
  lookup: '(query) => result',
  /** @returns {string} 供 diagnostics 展示的来源描述 */
  describe: '() => string',
};

/** 释义来源的优先级（数值越小优先级越高） */
export const MEANING_SOURCE_RANK = {
  revision: 0, // 人工修订
  wordlist: 1, // 当前词表
  provider: 2, // 释义提供者（本地词典文件）
  none: 99, // 没有
};

/** 释义来源的中文说明 */
export const MEANING_SOURCE_LABEL = {
  revision: '人工修订',
  wordlist: '当前词表',
  provider: '本地词典',
  none: '未找到',
};

const normalizeWord = (s) => String(s ?? '').trim();
const normalizeReading = (s) => String(s ?? '').trim();
const normalizePos = (s) => String(s ?? '').trim();

/**
 * 把一条「释义记录」规整成标准形态。
 */
function makeRecord(meaning, opts = {}) {
  return {
    meaning: String(meaning ?? '').trim(),
    meaningLanguage: opts.meaningLanguage || 'zh',
    source: opts.source || 'provider',
    sourceDetail: opts.sourceDetail ?? '',
  };
}

// ══════════════════════════════════════════════════════════
// 本地文件 provider（JSON / TSV）
// ══════════════════════════════════════════════════════════

/**
 * JSON 文件格式（推荐）：
 *
 * ```json
 * {
 *   "schema": "vocab-digest-meanings/1",
 *   "language": "ja",
 *   "meaningLanguage": "zh",
 *   "entries": [
 *     { "word": "日本", "reading": "ニホン", "pos": "prop.", "meaning": "日本" },
 *     { "word": "日本", "reading": "ニッポン", "pos": "prop.", "meaning": "（强调读音）日本" }
 *   ]
 * }
 * ```
 *
 * 也接受顶层直接是数组（等价于 entries）。
 * 每条的 `reading` / `pos` 可省略（省略 = 通配），但**同时给了就要精确匹配**。
 */
export function parseMeaningsJson(text, opts = {}) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    const err = new Error(`释义文件不是合法 JSON：${e.message}`);
    err.code = 'MEANINGS_LOAD_FAILED';
    throw err;
  }
  const list = Array.isArray(raw) ? raw : (raw.entries ?? []);
  if (!Array.isArray(list)) {
    const err = new Error('释义文件的 entries 必须是数组');
    err.code = 'MEANINGS_LOAD_FAILED';
    throw err;
  }
  const defaultLang = raw?.meaningLanguage ?? opts.meaningLanguage ?? 'zh';
  const out = [];
  for (const e of list) {
    const word = normalizeWord(e.word ?? e.lemma);
    if (!word) continue;
    out.push({
      word,
      reading: normalizeReading(e.reading),
      pos: normalizePos(e.pos),
      meaning: String(e.meaning ?? '').trim(),
      meaningLanguage: e.meaningLanguage || defaultLang,
      source: e.source || 'provider',
    });
  }
  return out;
}

/**
 * TSV 文件格式（给手写 / 从 Excel 导出用）：
 *
 * ```
 * # 注释行以 # 开头
 * # 列：词形 <TAB> 释义 <TAB> 读音(可选) <TAB> 词性(可选) <TAB> 释义语言(可选)
 * 日本	日本	nihon(ニホン)	prop.	zh
 * ```
 *
 * 也接受用 **空格** 分隔的三列简写：`日本  日本  ニホン`
 */
export function parseMeaningsTsv(text, opts = {}) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const cols = t.includes('\t') ? t.split('\t') : t.split(/\s{2,}/);
    const word = normalizeWord(cols[0]);
    if (!word) continue;
    const meaning = String(cols[1] ?? '').trim();
    out.push({
      word,
      reading: normalizeReading(cols[2]),
      pos: normalizePos(cols[3]),
      meaning,
      meaningLanguage: String(cols[4] ?? '').trim() || (opts.meaningLanguage ?? 'zh'),
      source: 'provider',
    });
  }
  return out;
}

/**
 * 建立索引：同一 (词形, 读音, 词性) 只保留第一条；同时记录有多少条是「无读音」的通配。
 */
function indexRecords(records) {
  const exact = new Map(); // `${word}\u0000${reading}\u0000${pos}` → record
  const wildcard = new Map(); // word → [record...]（读音/词性为空的兜底）
  for (const r of records) {
    if (!r.meaning) continue;
    const key = `${r.word}\u0000${r.reading}\u0000${r.pos}`;
    if (exact.has(key)) continue;
    exact.set(key, r);
    if (!r.reading || !r.pos) {
      const arr = wildcard.get(r.word) ?? [];
      arr.push(r);
      wildcard.set(r.word, arr);
    }
  }
  return { exact, wildcard };
}

/**
 * 创建本地文件释义提供者。
 *
 * @param {object} opts
 *   - file: 释义文件路径（.json / .tsv / .txt）
 *   - meaningLanguage: 文件没写释义语言时的默认值
 * @returns provider
 *
 * provider.lookup({word, reading, pos, entryKey}) 返回
 *   - 命中：{ ok:true, meaning, meaningLanguage, source:'provider', sourceDetail }
 *   - 未命中：{ ok:true, meaning:'', meaningLanguage:'', source:'provider', found:false }
 *   - 未配置：{ ok:false, error:'NOT_CONFIGURED', ... }（由 createNoopProvider 返回）
 *   - 加载失败：{ ok:false, error:'LOAD_FAILED', message, ... }
 */
export function createFileProvider(opts = {}) {
  const file = opts.file ? String(opts.file) : '';
  const base = {
    kind: 'file',
    file,
    loaded: false,
    status: 'idle', // idle | ok | failed
    error: '',
    count: 0,
  };

  if (!file) {
    return {
      ...base,
      status: 'unconfigured',
      describe: () => '未配置释义文件',
      lookup: () => ({
        ok: false, error: 'NOT_CONFIGURED', message: '未配置释义文件', meaning: '', meaningLanguage: '', source: 'provider', found: false,
      }),
    };
  }

  let idx = { exact: new Map(), wildcard: new Map() };
  let status = 'ok';
  let error = '';
  let count = 0;

  if (!existsSync(file)) {
    // ⚠️ 这里必须区分两件事，否则会把拼写错误吞掉：
    //   - **用户显式配置**了路径但文件不在 → failed（路径写错了，要让他看见）
    //   - **默认探测**的路径不存在     → unconfigured（还没准备释义，属正常）
    if (opts.explicit) {
      status = 'failed';
      error = `配置的释义文件不存在：${file}`;
    } else {
      status = 'unconfigured';
      error = `未找到释义文件：${file}`;
    }
  } else {
    try {
      const text = readFileSync(file, 'utf8');
      const ext = extname(file).toLowerCase();
      let records;
      if (ext === '.json') records = parseMeaningsJson(text, opts);
      else records = parseMeaningsTsv(text, opts);
      idx = indexRecords(records);
      count = idx.exact.size;
    } catch (e) {
      status = 'failed';
      error = e.message;
    }
  }

  const provider = {
    ...base,
    loaded: status === 'ok',
    status,
    error,
    count,
    describe: () => {
      if (status === 'ok') return `本地释义文件：${file}（${count} 条）`;
      if (status === 'unconfigured') return `未找到释义文件：${file}（不影响抽取，只是没有释义）`;
      return `本地释义文件加载失败：${error}`;
    },

    /**
     * @param {{word:string, reading?:string, pos?:string, entryKey?:string}} q
     */
    lookup(q = {}) {
      const word = normalizeWord(q.word);
      if (status !== 'ok') {
        return {
          ok: false,
          error: status === 'failed' ? 'LOAD_FAILED' : 'NOT_CONFIGURED',
          message: status === 'failed' ? error : `未找到释义文件：${file}`,
          meaning: '', meaningLanguage: '', source: 'provider', found: false,
        };
      }
      const reading = normalizeReading(q.reading);
      const pos = normalizePos(q.pos);

      // ① 三者都精确匹配
      const hit = idx.exact.get(`${word}\u0000${reading}\u0000${pos}`);
      if (hit) return { ok: true, found: true, ...makeRecord(hit.meaning, hit), sourceDetail: file };

      // ② 读音 + 词性给了，但文件里那条没写读音/词性（通配）
      for (const r of idx.wildcard.get(word) ?? []) {
        if (r.reading && r.reading !== reading) continue;
        if (r.pos && r.pos !== pos) continue;
        return { ok: true, found: true, ...makeRecord(r.meaning, r), sourceDetail: file };
      }

      // ③ 兜底：只按词形（同形异读时这一步**故意不做**，避免串项）
      if (reading || pos) {
        const onlyWord = [...idx.exact.values()].find((r) => r.word === word && !r.reading && !r.pos);
        if (onlyWord) return { ok: true, found: true, ...makeRecord(onlyWord.meaning, onlyWord), sourceDetail: file };
      }

      return {
        ok: true, found: false, meaning: '', meaningLanguage: '', source: 'provider', sourceDetail: file,
      };
    },
  };
  return provider;
}

/** 未配置时的空 provider */
export function createNoopProvider(reason = '未配置释义文件') {
  return {
    kind: 'noop',
    status: 'unconfigured',
    loaded: false,
    error: '',
    count: 0,
    describe: () => reason,
    lookup: () => ({
      ok: false, error: 'NOT_CONFIGURED', message: reason, meaning: '', meaningLanguage: '', source: 'provider', found: false,
    }),
  };
}

/**
 * 按配置创建 provider。
 *
 * 配置来源：`config.meaning.file`（en/ja 各自可以用 `config.meaning.ja.file`）。
 * 默认日文查 `data/ja/meanings.json` / `data/ja/meanings.tsv`（存在就用）。
 */
export function createProviderFromConfig(config, language = 'en') {
  const m = config?.meaning ?? {};
  const langCfg = m[language] ?? {};
  // 用户**显式写了**路径（配置里真的填了 file 字段）→ 文件不在就是 failed
  const configured = langCfg.file ?? m.file ?? '';
  if (configured) {
    return createFileProvider({
      file: configured,
      meaningLanguage: langCfg.meaningLanguage ?? m.meaningLanguage,
      explicit: true,
    });
  }
  // 以下是「默认探测」：找不到属于正常未配置，不报 failed
  if (language === 'ja') {
    const dataDir = config?.dataDir ?? '';
    for (const name of ['meanings.json', 'meanings.tsv']) {
      const p = `${dataDir ? `${dataDir}/` : ''}ja/${name}`;
      if (existsSync(p)) {
        return createFileProvider({ file: p, meaningLanguage: langCfg.meaningLanguage ?? 'zh' });
      }
    }
    return createNoopProvider('未配置日文释义文件（data/ja/meanings.json 可选）');
  }
  return createNoopProvider('未配置释义文件');
}

// ══════════════════════════════════════════════════════════
// 三层优先级解析
// ══════════════════════════════════════════════════════════

/**
 * 解析一条词条的释义，按优先级：**人工修订 > 当前词表 > provider**。
 *
 * @param {object} q
 *   - word, reading, pos, entryKey
 *   - revision: 人工修订记录 `{meaning, meaningLanguage?}` 或 undefined
 *   - wordlist: 词表卡片释义 `{meaning, meaningLanguage?}` 或 undefined
 *   - provider: provider 实例（可省略）
 * @returns {{
 *   meaning: string,
 *   meaningLanguage: string,
 *   meaningSource: 'revision'|'wordlist'|'provider'|'none',
 *   meaningSourceDetail: string,
 *   providerStatus: 'unconfigured'|'ok'|'failed'|'skipped',
 *   providerError: string
 * }}
 */
export function resolveMeaning(q = {}) {
  const providerStatus = q.provider ? (q.provider.status ?? 'ok') : 'skipped';

  // ① 人工修订
  const rev = q.revision;
  if (rev && String(rev.meaning ?? '').trim()) {
    return {
      meaning: String(rev.meaning).trim(),
      meaningLanguage: rev.meaningLanguage || 'zh',
      meaningSource: 'revision',
      meaningSourceDetail: rev.sourceDetail ?? 'decisions.json',
      providerStatus,
      providerError: '',
    };
  }

  // ② 当前词表
  const wl = q.wordlist;
  if (wl && String(wl.meaning ?? '').trim()) {
    return {
      meaning: String(wl.meaning).trim(),
      meaningLanguage: wl.meaningLanguage || 'zh',
      meaningSource: 'wordlist',
      meaningSourceDetail: wl.sourceDetail ?? '当前词表',
      providerStatus,
      providerError: '',
    };
  }

  // ③ provider
  if (q.provider) {
    const r = q.provider.lookup(q);
    if (r.found && r.meaning) {
      return {
        meaning: r.meaning,
        meaningLanguage: r.meaningLanguage || 'zh',
        meaningSource: 'provider',
        meaningSourceDetail: r.sourceDetail ?? '',
        providerStatus,
        providerError: '',
      };
    }
    if (!r.ok) {
      return {
        meaning: '',
        meaningLanguage: '',
        meaningSource: 'none',
        meaningSourceDetail: '',
        providerStatus: r.error === 'LOAD_FAILED' ? 'failed' : 'unconfigured',
        providerError: r.message ?? '',
      };
    }
  }

  return {
    meaning: '',
    meaningLanguage: '',
    meaningSource: 'none',
    meaningSourceDetail: '',
    providerStatus,
    providerError: '',
  };
}

/**
 * 把「释义缺失」汇总成一条提示（不逐词刷屏）。
 *
 * @param {Array<object>} items 带 meaningSource 的词条
 * @param {{status:string, error:string}} providerInfo
 * @returns {Array<{level:string, message:string}>} 警告
 */
export function meaningWarnings(items, providerInfo = {}) {
  const out = [];
  const total = items.length;
  const missing = items.filter((it) => !String(it.meaning ?? '').trim());
  if (providerInfo.status === 'failed') {
    out.push({
      level: 'warn',
      message: `释义文件加载失败（${providerInfo.error}）：本次所有词条都没有释义，但词条和 Word 仍会正常生成。`,
    });
  } else if (providerInfo.status === 'unconfigured' && missing.length) {
    out.push({
      level: 'info',
      message: `没有配置释义来源：本次 ${missing.length}/${total} 个词条没有释义。可以放一份 data/ja/meanings.json（或用词表里已有的释义）来补。`,
    });
  } else if (missing.length) {
    out.push({
      level: 'info',
      message: `${missing.length}/${total} 个词条没有释义（词表与释义文件里都没查到）。`,
    });
  }
  return out;
}
