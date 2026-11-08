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
import { extname, join, relative, resolve } from 'node:path';
import { resolveConfig } from './config.js';
import { TAG_DIM_LABELS } from './classify.js';
import { ensureData } from './data/seed.js';
import { writeDocx } from './docx/write.js';
import { digest } from './pipeline.js';
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
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** 标题默认用第一个输入的目录名（比文件名更像「这期视频」），没有就退回文件名 */
function defaultTitle(result, config) {
  const first = result.sources[0]?.name ?? '输入';
  const parts = String(first).split(/[\\/]/);
  const base = parts.length > 1 ? parts[parts.length - 2] : parts[0];
  const prefix = config.docx?.titlePrefix ?? '英语词汇整理';
  return `${prefix} · ${base || first}`;
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

/** 准备配置 + 首次初始化词表 */
export function prepareConfig(opts = {}) {
  const config = resolveConfig({
    cwd: opts.cwd,
    localConfigPath: opts.localConfigPath,
    overrides: opts.configOverrides,
    dataDirOverride: opts.dataDirOverride,
  });
  const createdFiles = opts.initData === false ? [] : ensureData(config.dataDir);
  // 初始化后再解析一次，让 missingFiles 反映真实状态
  const refreshed = resolveConfig({
    cwd: opts.cwd,
    localConfigPath: opts.localConfigPath,
    overrides: opts.configOverrides,
    dataDirOverride: opts.dataDirOverride,
  });
  return { config: refreshed, createdFiles };
}

/** 读输入文件成 { name, ext, raw } */
export function readInputs(files, cwd) {
  return files.map((f) => ({
    name: cwd && f.path.startsWith(resolve(cwd)) ? relative(resolve(cwd), f.path) || f.path : f.path,
    ext: f.ext,
    raw: readFileSync(f.path, 'utf8'),
  }));
}

/** 把 digest 结果 + 配置转成文档模型 */
export function buildDocModel(result, config, generatedAt) {
  const title = config.docx?.title ?? defaultTitle(result, config);
  return {
    title,
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
    store.touch(target.id, { count: cards.length });
    return { id: target.id, name: target.name, count: cards.length, replaced: true };
  }
  const created = store.create({ name, cards, source: digestData.runId ?? '' });
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
  const started = Date.now();
  const cwd = opts.cwd ?? process.cwd();
  const { config, createdFiles } = prepareConfig({ ...opts, cwd });

  const inputFiles = expandInputs(opts.inputs ?? [], config.input?.formats);
  if (!inputFiles.length) {
    const err = new Error(`没有匹配到可处理的输入文件（支持 ${DEFAULT_FORMATS.join('/')}）`);
    err.code = 'INPUT_EMPTY';
    throw err;
  }

  const runId = opts.runId ?? makeRunId();
  const runDir = join(config.runRoot, runId);
  mkdirSync(runDir, { recursive: true });

  const decisionsFile = join(runDir, 'decisions.json');
  const decisions = existsSync(decisionsFile) ? readDecisions(decisionsFile) : {};

  const genConfig = opts.title ? { ...config, docx: { ...config.docx, title: opts.title } } : config;

  // 词表系统：指定了词表就把它的释义/词性并进本次运行（词表里的词同时进词典，
  // 这样 commitments → commitment → 命中词表的「承诺」）
  let wlPatch = { decisions: {}, patchDecisions: {}, words: new Set() };
  if (opts.wordlist) {
    const store = new WordlistStore(config.dataDir);
    if (store.exists(opts.wordlist)) {
      wlPatch = store.lexiconPatch(opts.wordlist);
      const kf = store.knownFileOf(opts.wordlist);
      genConfig.lexicon = { ...genConfig.lexicon, knownFile: kf };
    }
  }

  // 本地英汉词典（可选）：data/ecdict.csv 在就用它补中文释义
  const dict = openEcdict(ecdictPath(config.dataDir));

  const result = digest(readInputs(inputFiles, cwd), genConfig, {
    decisions,
    patchDecisions: wlPatch.decisions,
    wlPatch,
    dict,
  });
  const generatedAt = localIso();
  const docModel = buildDocModel(result, genConfig, generatedAt);

  const docxPath = join(runDir, 'vocab.docx');
  const docxOpts = { toc: genConfig.docx?.toc !== false, fontCn: genConfig.docx?.fontCn, fontEn: genConfig.docx?.fontEn };
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
}

export function readDecisions(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

/**
 * 把人工 / 翻译回写应用到结果上（幂等）。
 * decisions 结构：{ "<word>": { "pos": "n.", "meaning": "中文释义" } } 或 { "<word>": "n." }
 */
export function applyDecisions(result, decisions) {
  const get = (w) => {
    const d = decisions[w];
    if (!d) return {};
    if (typeof d === 'string') return { pos: d };
    return { pos: d.pos, meaning: d.meaning };
  };
  const items = (result.items ?? []).map((it) => {
    const d = get(it.word);
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
  const dig = JSON.parse(readFileSync(join(runDir, 'digest.json'), 'utf8'));
  const { config } = prepareConfig({
    cwd: opts.cwd,
    localConfigPath: opts.localConfigPath,
    dataDirOverride: opts.dataDirOverride,
    configOverrides: opts.configOverrides,
  });
  const decisions = opts.decisions ?? (existsSync(join(runDir, 'decisions.json')) ? readDecisions(join(runDir, 'decisions.json')) : {});

  const merged = applyDecisions(dig, decisions);
  const genConfig = opts.title ? { ...config, docx: { ...config.docx, title: opts.title } } : config;
  const generatedAt = localIso();
  const docModel = buildDocModel(merged, genConfig, generatedAt);
  const docxPath = join(runDir, 'vocab.docx');
  const docxOpts = { toc: genConfig.docx?.toc !== false, fontCn: genConfig.docx?.fontCn, fontEn: genConfig.docx?.fontEn };
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
