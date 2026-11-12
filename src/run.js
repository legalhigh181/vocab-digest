/**
 * 一次完整运行的编排：读输入 → digest → 生成 docx → 自检 → 落盘 run 目录。
 *
 * run 目录结构（runs/<runId>/）：
 *   digest.json     中间结果（词条、章节、统计，可复现）
 *   vocab.docx      成品
 *   report.json     自检报告
 *   run.json        运行元信息（输入哈希、参数、耗时）
 *   decisions.json  人工回写（可选，存在则优先生效）
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { resolveConfig } from './config.js';
import { TAG_DIM_LABELS } from './classify.js';
import { ensureData } from './data/seed.js';
import { writeDocx } from './docx/write.js';
import { docDefaultsFor } from './docx/build.js';
import { prepareLanguageRuntime } from './languages/runtime.js';
import { normalizeLanguage } from './languages/index.js';
import { digest, digestJapaneseSync } from './pipeline.js';
import { normalizeJaEntryKey } from './ja/entrykey.js';
import { createProviderFromConfig } from './meanings.js';
import { ecdictPath, openEcdict } from './lexicon/ecdict.js';
import { sha256, stablePretty } from './util.js';
import { verifyRun } from './verify.js';
import { WordlistStore } from './wordlists/store.js';

const DEFAULT_FORMATS = ['json', 'xml', 'srt', 'vtt', 'ass', 'ssa', 'txt'];

function pad(n) {
  return String(n).padStart(2, '0');
}

export function localIso(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function makeRunId(d = new Date()) {
  // 末尾加随机后缀：只到秒的时间戳在同一秒并发两个任务时会撞车（T6 修）
  const rand = Math.random().toString(36).slice(2, 6);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${rand}`;
}

/** 真正取新 ID 的地方：测试可以替换它来强制撞车 */
function nextRunId() {
  return runIdFactory ? runIdFactory() : makeRunId();
}

/** 本进程内已经认领的运行 ID（按 runRoot 分组），防止并发两次抢到同一个 ID */
let claimedRunIds = new Set();
let lastRunRootFor = '';
/**
 * 测试用钩子：允许注入 makeRunId 来「强制撞车」，验证重试路径真的会重试。
 * 生产环境永远是 undefined。
 */
let runIdFactory = null;
/** @internal 仅供测试：设置/清除 makeRunId 替身 */
export function __setRunIdFactory(fn) { runIdFactory = fn; }
let collisionLog = null;
/** @internal 仅供测试：把每次「撞车后换 ID」记进 arr */
export function __setCollisionLog(arr) { collisionLog = arr ?? null; }
/**
 * @internal 仅供测试：设置运行钩子。目前只有 afterClaim：
 * 在「已经占了运行目录、但还没跑完」的那一刻回调，用来验证「运行中不许被抢」。
 */
let runHook = null;
export function __setHook(h) { runHook = h ?? null; }

/** 标题默认用第一个输入的目录名（比文件名更像「这期视频」），没有就退回文件名 */
function defaultTitle(result, config) {
  const first = result.sources[0]?.name ?? '输入';
  const parts = String(first).split(/[\\/]/);
  const base = parts.length > 1 ? parts[parts.length - 2] : parts[0];
  // 前缀按语言取：日语文档不能还叫「英语词汇整理」。
  // 显式配置的 titlePrefix 永远优先（用户改过就要尊重）。
  const prefix = config.docx?.titlePrefix ?? docDefaultsFor(config.language ?? result.language).titlePrefix;
  return `${prefix} · ${base || first}`;
}

/**
 * 文档渲染选项：提取一次，run / render 两条路径共用。
 * fontCn 在 docx 层是「亚洲字形字体」，日文要换成 Meiryo（等线在日文系统上多半没有）。
 */
function docxOptions(config, language) {
  const lang = language === 'ja' ? 'ja' : 'en';
  const d = docDefaultsFor(lang);
  return {
    toc: config.docx?.toc !== false,
    fontCn: config.docx?.fontCn,
    fontEn: config.docx?.fontEn,
    eastAsia: config.docx?.fontCn ?? d.eastAsiaFont,
    eastAsiaLang: d.eastAsiaLang,
    language: lang,
  };
}

function extsOf(formats) {
  return new Set((formats?.length ? formats : DEFAULT_FORMATS).map((f) => `.${String(f).toLowerCase().replace(/^\./, '')}`));
}

/** 展开输入：文件原样，目录递归取允许的扩展名；排序去重保证稳定 */
export function expandInputs(inputs, formats) {
  const allowed = extsOf(formats);
  const out = new Map();
  const walk = (p) => {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const entry of readdirSync(p).sort()) walk(join(p, entry));
      return;
    }
    const ext = extname(p).toLowerCase();
    if (!allowed.has(ext)) return;
    const full = resolve(p);
    if (!out.has(full)) out.set(full, { path: full, ext: ext.slice(1), size: st.size });
  };
  for (const p of inputs) {
    const full = resolve(p);
    if (!existsSync(full)) {
      const err = new Error(`输入不存在：${p}`);
      err.code = 'INPUT_MISSING';
      throw err;
    }
    walk(full);
  }
  return [...out.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * 准备配置 + 首次初始化词表
 *
 * 语言相关：`opts.language` 显式指定优先；否则用配置文件里的 language（缺省 en）。
 * 初始化词表时按语言建对应目录（英语 data/，日语 data/ja/），绝不跨语言要求文件齐全。
 */
export function prepareConfig(opts = {}) {
  const base = {
    cwd: opts.cwd,
    localConfigPath: opts.localConfigPath,
    overrides: opts.configOverrides,
    dataDirOverride: opts.dataDirOverride,
    language: opts.language,
  };
  const config = resolveConfig(base);
  const createdFiles = opts.initData === false ? [] : ensureData(config.dataDir, { language: config.language });
  // 初始化后再解析一次，让 missingFiles 反映真实状态
  const refreshed = resolveConfig(base);
  return { config: refreshed, createdFiles };
}

/**
 * 准备语言运行时（异步）：建词表目录 + 校验文件 + 登记适配器。
 * 同步的 runDigest 不调用它；需要日语的调用方走 runDigestAsync。
 */
export async function prepareRuntime(opts = {}) {
  const base = {
    cwd: opts.cwd,
    localConfigPath: opts.localConfigPath,
    overrides: opts.configOverrides,
    dataDirOverride: opts.dataDirOverride,
    language: opts.language,
  };
  const config = resolveConfig(base);
  return prepareLanguageRuntime(config, { initData: opts.initData, resolveConfig: () => resolveConfig(base) });
}

/**
 * 异步版 runDigest：先把语言运行时准备好，再走原有的同步编排。
 * 同步的 runDigest 契约保持不变（英语调用方不需要改）。
 */
export async function runDigestAsync(opts = {}) {
  const runtime = await prepareRuntime(opts);
  if (!runtime.ready) {
    const err = new Error(
      `缺少词表文件：${runtime.missing.map((m) => `${m.key} (${m.path || '未配置'})`).join('、')}`,
    );
    err.code = 'LEXICON_MISSING';
    err.missing = runtime.missing;
    err.language = runtime.language;
    throw err;
  }
  // 日文：先把分词器加载好（词典加载约 200ms，进程内复用），再走同步编排
  let tokenizer = null;
  if (runtime.language === 'ja') {
    const { buildTokenizer } = await import('./ja/tokenizer.js');
    tokenizer = await buildTokenizer();
  }
  return runDigest({ ...opts, _runtimeReady: true, _jaTokenizer: tokenizer });
}

/** 读输入文件成 { name, ext, raw } */
export function readInputs(files, cwd) {
  return files.map((f) => {
    // 输入可能是「subtitle / audio.srt」这种点号路径（会话目录名里带点），
    // extname 会把扩展名认错，这里显式用 path.extname 兜底重算
    const ext = f.ext && /\w/.test(f.ext) ? f.ext : extname(String(f.path)).replace(/^\./, '');
    return {
      name: cwd && f.path.startsWith(resolve(cwd)) ? relative(resolve(cwd), f.path) || f.path : f.path,
      ext,
      raw: readFileSync(String(f.path), 'utf8'),
    };
  });
}

/** 把 digest 结果 + 配置转成文档模型 */
export function buildDocModel(result, config, generatedAt) {
  const title = config.docx?.title ?? defaultTitle(result, config);
  // 语言进 docModel：封面标题、字体、读音小标题都按它取（重渲染时也是从 digest.json 读回来）
  const language = config.language ?? result.language ?? 'en';
  const d = docDefaultsFor(language);
  return {
    title,
    language,
    eastAsiaFont: config.docx?.fontCn ?? d.eastAsiaFont,
    eastAsiaLang: d.eastAsiaLang,
    subtitle: `共 ${result.stats.keptCount} 个词条 · ${result.stats.fileCount} 个输入文件`,
    generatedAt,
    sources: result.sources,
    stats: result.stats,
    params: [
      { key: '最低词长', value: config.lexicon?.minLen },
      { key: '最低词频', value: config.lexicon?.minFreq },
      { key: '每词用法条数', value: config.docx?.usagePerWord ?? 5 },
      { key: '短语门槛', value: `PMI ≥ ${config.lexicon?.phraseMinPmi ?? 3}，边界熵 ≥ ${config.lexicon?.phraseMinEntropy ?? 0.8}` },
      { key: '分章标签', value: (config.classify?.by ?? ['pos']).map((d) => TAG_DIM_LABELS[d] ?? d).join(' + ') },
      { key: '引擎版本', value: result.version },
    ],
    sections: result.sections,
    tags: result.tags ?? {},
    topWords: result.topWords,
    filtered: result.filtered,
  };
}

/** 词表系统：把一次 run 的词条变成某张词表的卡片（新增 / 覆盖两种模式） */
export function wordlistFromRun(store, runIdOrDir, opts = {}) {
  const dir = resolve(store.cwd ?? store.dataDir, '..', 'runs', runIdOrDir);
  const fromDir = resolve(runIdOrDir);
  const runDir = existsSync(join(fromDir, 'digest.json')) ? fromDir : dir;
  const file = join(runDir, 'digest.json');
  if (!existsSync(file)) {
    const err = new Error(`找不到运行结果：${file}`);
    err.code = 'RUN_NOT_FOUND';
    throw err;
  }
  const digestData = JSON.parse(readFileSync(file, 'utf8'));
  const cards = store.cardsFromDigest(digestData);
  const name = opts.name || digestData.title || `来自 ${digestData.runId ?? runIdOrDir}`;

  // 指定了要覆盖的表 → 整表替换；否则同名表存在就覆盖，不存在就新建
  let target = opts.listId ? store.list().find((l) => l.id === opts.listId) : null;
  if (!target && opts.replace) target = store.list().find((l) => l.name === name) ?? null;
  if (target) {
    store.writeCards(target.id, cards);
    store.touch(target.id, cards.length);
    return { id: target.id, name: target.name, count: cards.length, replaced: true };
  }
  const created = store.create({ name, cards, source: digestData.runId ?? '', language: digestData.language ?? 'en' });
  return { id: created.id, name: created.name, count: cards.length, replaced: false };
}

function safeName(s) {
  return String(s).replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
}

/**
 * 跑一次完整 digest。
 * @param {object} opts { inputs:string[], cwd, runId, configOverrides, localConfigPath, dataDirOverride, title, videoUrl, videoTitle, wordlist }
 */
export function runDigest(opts = {}) {
  return runDigestSync(opts);
}

function runDigestSync(opts = {}) {
  const started = Date.now();
  const cwd = opts.cwd ?? process.cwd();
  const { config, createdFiles } = prepareConfig({ ...opts, cwd });
  const inputFiles = expandInputs(opts.inputs ?? [], config.input?.formats);
  if (!inputFiles.length) {
    const err = new Error(`没有匹配到可处理的输入文件（支持 ${DEFAULT_FORMATS.join('/')}）`);
    err.code = 'INPUT_EMPTY';
    throw err;
  }

  // ── 运行目录隔离（T6）──────────────────────────────────────────────
  // 过去 runId 是「到秒的时间戳」，两个任务在同一秒启动会撞进同一个目录，
  // 后一次的 digest.json / vocab.docx 直接盖掉前一次，前一次的中间态也会混进来。
  //
  // 现在的规则：
  //   · makeRunId 自带随机后缀，正常分配走「mkdir 失败就换一个」，抢到的那个任务独占目录；
  //   · **显式传入的 runId 默认不许复用**——目录已存在直接 RUN_DIR_CONFLICT，
  //     要覆盖必须显式传 overwrite:true，而且正在被别的任务占着的目录一律不许覆盖；
  //   · 同一进程内的占用表按 runRoot 分组，覆盖所有「目录刚建出来但任务还没跑完」的窗口。
  let runId = opts.runId ?? nextRunId();
  const rootKey = resolve(config.runRoot);
  if (claimedRunIds.size === 0 || lastRunRootFor !== rootKey) {
    claimedRunIds.clear();
    lastRunRootFor = rootKey;
  }

  if (opts.runId) {
    if (claimedRunIds.has(runId)) {
      const err = new Error(`运行目录正被另一个任务占用：${runId}`);
      err.code = 'RUN_DIR_CONFLICT';
      err.runId = runId;
      err.reason = 'busy';
      throw err;
    }
    const exists = existsSync(join(config.runRoot, runId));
    if (exists && !opts.overwrite) {
      const err = new Error(`运行目录已存在：${runId}（要覆盖必须显式允许）`);
      err.code = 'RUN_DIR_CONFLICT';
      err.runId = runId;
      err.reason = 'exists';
      throw err;
    }
    mkdirSync(join(config.runRoot, runId), { recursive: true });
    claimedRunIds.add(runId);
  } else {
    mkdirSync(config.runRoot, { recursive: true });
    let made = false;
    for (let i = 0; i < 32 && !made; i += 1) {
      try {
        mkdirSync(join(config.runRoot, runId), { recursive: false });
        made = true;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        // 撞车：记一笔，然后换一个新 ID 再抢（同一个 ID 撞过就不会再试）
        collisionLog?.push(runId);
        do { runId = nextRunId(); } while (claimedRunIds.has(runId));
        claimedRunIds.add(runId);
      }
    }
    if (!made) {
      claimedRunIds.delete(runId);
      const err = new Error('无法创建运行目录（重试 32 次仍冲突）');
      err.code = 'RUN_DIR_CONFLICT';
      err.reason = 'exhausted';
      throw err;
    }
  }
  const runDir = join(config.runRoot, runId);
  // 任务结束（成功/失败/抛错）后释放占用，目录留着以备下次显式覆盖
  const releaseRunId = () => { claimedRunIds.delete(runId); };
  runHook?.afterClaim?.(runId);
  try {

    const decisionsFile = join(runDir, 'decisions.json');
    const decisions = existsSync(decisionsFile) ? readDecisions(decisionsFile) : {};

    const genConfig = opts.title ? { ...config, docx: { ...config.docx, title: opts.title } } : config;

    // 词表系统：指定了词表就把它的释义/词性并进本次运行（词表里的词同时进词典，
    // 这样 commitments → commitment → 命中词表的「承诺」）
    const language = genConfig.language ?? 'en';
    let wlPatch = { decisions: {}, patchDecisions: {}, words: new Set() };
    let wordlistMeanings = null;
    /** 词表里「已掌握」的词（entryKey 或裸词形），日文与英文共用同一份语义 */
    let knownWords = new Set();
    if (opts.wordlist) {
      const store = new WordlistStore(config.dataDir);
      if (store.exists(opts.wordlist)) {
        wlPatch = store.lexiconPatch(opts.wordlist);
        if (language === 'en') {
          // 英文：把 known.txt 当词典的已知词表用（已掌握的词会被过滤）
          const kf = store.knownFileOf(opts.wordlist);
          genConfig.lexicon = { ...genConfig.lexicon, knownFile: kf };
        } else {
          // 日文：词表按 entryKey 提供释义（T5 起日文也能用词表）
          wordlistMeanings = store.meaningsByEntryKey(opts.wordlist);
          // ⚠️ 日文也要过滤已掌握的词，否则「标记已掌握」在日文路径下完全无效。
          // 必须用 known.txt 里的 entryKey（能区分同形异读），
          // 不能直接用 lexiconPatch().words（那是裸词形，会把 ニッポン 连带滤掉）。
          // 老 known.txt 可能是 NUL 格式，读进来先归一（见 normalizeJaEntryKey）。
          knownWords = new Set(store.known(opts.wordlist).map((k) => normalizeJaEntryKey(k)));
        }
      }
    }

    // 释义提供者（T4）：日文查本地释义文件；英文已经有 ECDICT，不再叠加
    const meaningProvider = opts.meaningProvider
      ?? (language === 'ja' ? createProviderFromConfig(genConfig, 'ja') : null);

    let result;
    if (language === 'ja') {
      // 日文管线是 async（kuromoji 加载），而 runDigest 的调用方既有同步也有异步。
      // 处理办法：分词器由 runDigestAsync 预先加载好并传进来，
      // 提交给一个「已 resolve 的微任务队列」再同步取回结果。
      if (!opts._jaTokenizer) {
        const err = new Error('日文处理需要先准备分词器：请用 runDigestAsync 或在 opts 里传 _jaTokenizer');
        err.code = 'JA_TOKENIZER_NOT_READY';
        throw err;
      }
      // 分词器是在 runDigestAsync 里 await 加载好的，这里所有分词调用都是同步的
      // （kuromoji 加载完成后 tokenize 本身同步），所以直接用同步版管线
      result = digestJapaneseSync(readInputs(inputFiles, cwd), genConfig, {
        tokenizer: opts._jaTokenizer,
        decisions,
        meaningProvider,
        wordlistMeanings,
        known: knownWords,
      });
    } else {
      // 本地英汉词典（可选）：data/ecdict.csv 在就用它补中文释义
      const dict = openEcdict(ecdictPath(config.dataDir));
      result = digest(readInputs(inputFiles, cwd), genConfig, {
        decisions,
        patchDecisions: wlPatch.decisions,
        wlPatch,
        dict,
      });
    }
    // 语言契约落盘：language 与 schemaVersion（无该字段的旧结果按 en 读）
    const generatedAt = localIso();
    const docModel = buildDocModel(result, genConfig, generatedAt);

    const docxPath = join(runDir, 'vocab.docx');
    const docxOpts = docxOptions(genConfig, language);
    const built = writeDocx(docxPath, docModel, docxOpts);

    const verify = verifyRun({
      documentXml: built.documentXml,
      zipBuf: built.zip,
      docModel,
      // 超链接关系表也要带进重渲染，否则 determinism 会被误判
      opts: { ...docxOpts, links: built.links },
      digest: result,
    });

    const inputHashes = inputFiles.map((f) => ({
      path: f.path,
      size: f.size,
      sha256: createHash('sha256').update(readFileSync(f.path)).digest('hex'),
    }));

    writeFileSync(join(runDir, 'digest.json'), stablePretty({
      version: result.version,
      schemaVersion: 2,
      language,
      sources: result.sources,
      stats: result.stats,
      dropped: result.dropped,
      lexicon: result.lexicon,
      sections: result.sections,
      tags: result.tags,
      topWords: result.topWords,
      filtered: result.filtered,
      warnings: result.warnings,
      // 词条本体要落盘：render / by-tag / translate 只读 digest.json，不重新解析输入
      items: result.items,
      known: result.known,
      wordlist: opts.wordlist ?? null,
      // 抓取来源的视频地址与原标题：应用里「点句子跳视频」和「原标题」都靠它
      videoUrl: opts.videoUrl ?? '',
      videoTitle: opts.videoTitle ?? (genConfig.docx?.title ?? ''),
      // 多 P 视频的分 P 号：不带它，点时间戳会跳到第 1 P
      videoPage: Number(opts.videoPage ?? 0) || 0,
      videoPages: Number(opts.videoPages ?? 0) || 0,
      runId,
    }), 'utf8');

    const report = {
      runId,
      generatedAt,
      ok: verify.ok,
      checks: verify.checks,
      documentXmlSha256: verify.documentXmlSha256,
      stats: verify.stats,
    };
    writeFileSync(join(runDir, 'report.json'), stablePretty(report), 'utf8');

    const runMeta = {
      runId,
      runDir,
      language,
      schemaVersion: 2,
      generatedAt,
      elapsedMs: Date.now() - started,
      inputs: inputHashes,
      params: {
        minLen: genConfig.lexicon?.minLen,
        minFreq: genConfig.lexicon?.minFreq,
        byPos: genConfig.classify?.byPos,
        bySource: genConfig.classify?.bySource,
      },
      outputs: {
        docx: docxPath,
        digest: join(runDir, 'digest.json'),
        report: join(runDir, 'report.json'),
      },
      stats: result.stats,
      warnings: result.warnings,
      title: genConfig.docx?.title ?? defaultTitle(result, genConfig),
      wordlist: opts.wordlist ?? null,
      verify: { ok: verify.ok, failed: verify.checks.filter((c) => c.status === 'fail') },
      documentXmlSha256: verify.documentXmlSha256,
      createdFiles,
      lexicon: result.lexicon,
    };
    writeFileSync(join(runDir, 'run.json'), stablePretty(runMeta), 'utf8');

    return { ...runMeta, documentXml: built.documentXml, docModel, result };
  } finally {
    // 成功/失败都要让出 runId：失败留下的半成品目录下次可以显式覆盖，
    // 但不能一直占着内存里的名额。
    releaseRunId();
  }
}

export function readDecisions(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object') return {};
    // 老 decisions.json 的日文键是 NUL 格式（`ja\0词形\0读音\0词性`），
    // 读入时归一成 `ja|…`，否则升级后人工修订会对不上词条而静默失效。
    const out = {};
    for (const [k, v] of Object.entries(raw)) out[normalizeJaEntryKey(k)] = v;
    return out;
  } catch {
    return {};
  }
}

/**
 * 把人工 / 翻译回写应用到结果上（幂等）。
 * decisions 结构：{ "<word>": { "pos": "n.", "meaning": "中文释义" } } 或 { "<word>": "n." }
 */
export function applyDecisions(result, decisions) {
  // 决策表按「词」索引，是英文时代留下的形状（英文靠小写折叠当 key）。
  // 日文同形异读（日本 / ニホン 与 ニッポン）会被合成一条，所以日文优先按 entryKey 查，
  // 查不到再退回 word，保证老的 decisions.json 仍然有效。
  //
  // 决策表的键也先归一：调用方可能直接传内存里的对象（没过 readDecisions），
  // 里面仍可能是 NUL 格式的老键。
  const table = {};
  for (const [k, v] of Object.entries(decisions ?? {})) table[normalizeJaEntryKey(k)] = v;
  const get = (it) => {
    const keys = [normalizeJaEntryKey(it.entryKey), it.entryKey, it.word].filter(Boolean);
    for (const k of keys) {
      const d = table[k];
      if (!d) continue;
      return typeof d === 'string' ? { pos: d } : { pos: d.pos, meaning: d.meaning };
    }
    return {};
  };
  const items = (result.items ?? []).map((it) => {
    const d = get(it);
    return {
      ...it,
      pos: d.pos && d.pos !== it.pos ? d.pos : it.pos,
      meaning: d.meaning ?? it.meaning ?? '',
    };
  });
  return { ...result, items };
}

/**
 * 只重新渲染（不重新解析输入）—— 改了 decisions.json 后重出 docx。
 * configOverrides 用于「换一种标签分章重出」，不传则用本机配置。
 */
export function renderRun(opts = {}) {
  const runDir = resolve(opts.runDir);
  const runId = basename(runDir);
  // 重渲染会覆盖 runDir 里的 vocab.docx / digest.json / run.json，
  // 所以它也要抢这次运行的目录：同一时刻只有一个写者。
  const rootKey = resolve(dirname(runDir));
  if (claimedRunIds.size === 0 || lastRunRootFor !== rootKey) {
    claimedRunIds.clear();
    lastRunRootFor = rootKey;
  }
  if (claimedRunIds.has(runId)) {
    const err = new Error(`运行目录正被另一个任务占用：${runId}`);
    err.code = 'RUN_DIR_CONFLICT';
    err.runId = runId;
    err.reason = 'busy';
    throw err;
  }
  claimedRunIds.add(runId);
  try {
    return renderRunUnclaimed(opts, runDir);
  } finally {
    claimedRunIds.delete(runId);
  }
}

function renderRunUnclaimed(opts, runDir) {
  const dig = JSON.parse(readFileSync(join(runDir, 'digest.json'), 'utf8'));
  /**
   * ⚠️ 重渲染必须沿用**这次运行自己的语言**，不能按当前配置的默认语言重算。
   * 否则用户先跑了一次日语、再去跑英文，回头点「重新生成 Word」会把日语结果当英文处理。
   * 旧运行没有 language 字段 → 一律按 en（T1 迁移规则）。
   */
  const runLanguage = dig?.language ?? 'en';
  /**
   * 显式语言与原运行冲突 → 明确拒绝，不能改写原语言。
   *
   * 重渲染是把已抽好的词条重新排版，不是重新分词。调用方传一个跟这次运行
   * 不一样的语言，说明它误以为能借此「换语言重跑」——如果放行，要么按错的语言
   * 排版（日文词条套英文模板），要么把 digest.json 的 language 改掉（下次打开就是错的）。
   * 两种都不对，所以直接报错，让调用方自己决定是重跑还是只改排版。
   */
  const explicitLanguage = opts.configOverrides?.language ?? opts.language;
  if (explicitLanguage && normalizeLanguage(explicitLanguage) !== runLanguage) {
    const err = new Error(
      `重渲染的语言与这次运行不一致：运行是 ${runLanguage}，调用方要求 ${explicitLanguage}。`
      + '重渲染不会重新分词，换语言请重新跑一次 digest。',
    );
    err.code = 'LANGUAGE_CONFLICT';
    err.runLanguage = runLanguage;
    err.requestedLanguage = explicitLanguage;
    throw err;
  }
  const { config } = prepareConfig({
    cwd: opts.cwd,
    localConfigPath: opts.localConfigPath,
    dataDirOverride: opts.dataDirOverride,
    configOverrides: { ...(opts.configOverrides ?? {}) },
    language: runLanguage,
  });
  const decisions = opts.decisions ?? (existsSync(join(runDir, 'decisions.json')) ? readDecisions(join(runDir, 'decisions.json')) : {});

  const merged = applyDecisions(dig, decisions);
  const genConfig = opts.title ? { ...config, docx: { ...config.docx, title: opts.title } } : config;
  const generatedAt = localIso();
  const docModel = buildDocModel(merged, genConfig, generatedAt);
  const docxPath = join(runDir, 'vocab.docx');
  const docxOpts = docxOptions(genConfig, runLanguage);
  const built = writeDocx(docxPath, docModel, docxOpts);
  const verify = verifyRun({ documentXml: built.documentXml, zipBuf: built.zip, docModel, opts: { ...docxOpts, links: built.links }, digest: merged });
  writeFileSync(join(runDir, 'report.json'), stablePretty({
    runId: dig?.runId ?? '',
    generatedAt,
    ok: verify.ok,
    checks: verify.checks,
    documentXmlSha256: verify.documentXmlSha256,
    stats: verify.stats,
  }), 'utf8');
  return { runDir, docxPath, generatedAt, verify, docModel };
}

/** 列出 runs/ 下的历史运行 */
export function listRuns(opts = {}) {
  const { config } = prepareConfig({ ...opts, initData: false });
  const root = config.runRoot;
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => existsSync(join(root, name, 'run.json')))
    .sort()
    .reverse()
    .map((name) => {
      const meta = JSON.parse(readFileSync(join(root, name, 'run.json'), 'utf8'));
      return {
        runId: meta.runId ?? name,
        runDir: join(root, name),
        generatedAt: meta.generatedAt,
        keptCount: meta.stats?.keptCount ?? 0,
        ok: Boolean(meta.verify?.ok),
        docx: meta.outputs?.docx ?? '',
      };
    });
}

export { sha256, safeName };
