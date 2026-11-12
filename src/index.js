/**
 * dsh-vocab-digest —— 弹幕/字幕 → 英语词汇 → 按标签分类的 Word 文档。
 *
 * Cordis 插件契约（照抄 dsh-cover-pipeline 的实证写法）：
 *   export const name   = '<插件 id>'
 *   export const inject = ['tools']
 *   export async function apply(ctx, config)
 *   tools.register({ name, description, parameters, output, execute })
 *
 * ★ 零运行时依赖：只用 node: 内置模块 + 本包自己的纯 JS 引擎。
 * ★ output.schema 是 additionalProperties:false —— execute 多返回一个字段就会被拒收，
 *   所以每个工具都严格按自己的 schema 返回（新增字段要同步改 schema）。
 *
 * 工具 = 流水线的每个决策点：
 *   vocab_transcribe     音视频 → srt（ffmpeg 内置 whisper；没有 CC 字幕时先走这步）
 *   vocab_plan           环境体检 + 参数预演（不动手，先把要做什么说清楚）
 *   vocab_collect        解析输入 → 抽词 → 出 digest.json（可先只看统计）
 *   vocab_translate      导出待翻译批次 / 回写词性+释义 → 重出文档
 *   vocab_build_docx     生成 Word + 自检报告
 *   vocab_by_tag         按标签查看（导出 txt，或切换文档的分章维度重出）
 *   vocab_status         历史运行、词表状态、语音转写可用性
 *   vocab_fetch          从 B 站视频取数（字幕 / 弹幕 / 无字幕时自动语音识别）
 *   vocab_wordlist       自建词表：列出 / 新建 / 重命名 / 切换 / 导入 / 加入 / 从运行建表 / 从词表重新整理
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { transcribe } from './asr.js';

import { TAG_DIMENSIONS, TAG_DIM_LABELS } from './classify.js';
import { resolveConfig } from './config.js';
import { ensureData } from './data/seed.js';
import { batchesOf, exportTagView, filterItems, loadRunDigest } from './export.js';
import { listRuns, localIso, readDecisions, renderRun, runDigest, runDigestAsync, wordlistFromRun } from './run.js';
import { stablePretty } from './util.js';
import { WordlistStore } from './wordlists/store.js';

export const name = 'vocab-digest';
export const inject = ['tools'];

// ───────────────────────────────────────────────────────────────────────────
// 通用
// ───────────────────────────────────────────────────────────────────────────

const textOut = (schema, fn) => ({ schema, render: (_a, v) => [{ type: 'text', text: fn(v) }] });

/** 插件配置 → 引擎配置覆盖 */
function overridesOf(config = {}) {
  const o = {};
  if (config.dataDir) o.dataDir = config.dataDir;
  if (config.runRoot) o.runRoot = config.runRoot;
  // 语言：en / ja（jp 归一为 ja），非法值由 normalizeLanguage 抛 INVALID_LANGUAGE
  if (config.language) o.language = String(config.language);
  if (config.minLen != null) o.lexicon = { ...(o.lexicon ?? {}), minLen: Number(config.minLen) };
  if (config.minFreq != null) o.lexicon = { ...(o.lexicon ?? {}), minFreq: Number(config.minFreq) };
  if (config.by) o.classify = { ...(o.classify ?? {}), by: String(config.by).split(',').map((s) => s.trim()).filter(Boolean) };
  if (config.fontCn) o.docx = { ...(o.docx ?? {}), fontCn: config.fontCn };
  if (config.fontEn) o.docx = { ...(o.docx ?? {}), fontEn: config.fontEn };
  if (config.toc === false) o.docx = { ...(o.docx ?? {}), toc: false };
  return o;
}

/** 解析运行目录：接受 runId 或绝对/相对路径 */
function resolveRunDir(config, runDir, runId) {
  if (runDir) {
    const p = resolve(String(runDir));
    return existsSync(join(p, 'digest.json')) ? p : '';
  }
  if (!runId) return '';
  const cfg = resolveConfig({ cwd: config.cwd || process.cwd(), overrides: overridesOf(config) });
  const p = join(cfg.runRoot, String(runId));
  return existsSync(join(p, 'digest.json')) ? p : '';
}

function runsOf(config) {
  const cfg = resolveConfig({ cwd: config.cwd || process.cwd(), overrides: overridesOf(config) });
  if (!existsSync(cfg.runRoot)) return [];
  return readdirSync(cfg.runRoot)
    .filter((n) => existsSync(join(cfg.runRoot, n, 'run.json')))
    .sort()
    .reverse();
}

function tail(s, n = 1200) {
  const t = String(s ?? '');
  return t.length <= n ? t : `…\n${t.slice(-n)}`;
}

// ───────────────────────────────────────────────────────────────────────────
// 插件主体
// ───────────────────────────────────────────────────────────────────────────

export async function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console;
  const tools = ctx.get('tools');
  if (!tools || typeof tools.register !== 'function') {
    logger.warn('[vocab-digest] tools 服务不可用，插件未注册任何工具');
    return;
  }
  const cfg = { ...config };

  // ── 1 · 计划与体检 ────────────────────────────────────────────────────
  tools.register({
    name: 'vocab_plan',
    description:
      '词汇整理前的体检与预演：检查词表目录（data/）是否齐全、输入文件能否识别，'
      + '并给出本次要用的参数（最低词长/词频、分章标签、样本数）。不写任何文件。'
      + '★ 任何整理任务开始前先跑这个，确认输入路径与词表状态。',
    parameters: {
      type: 'object',
      properties: {
        inputs: {
          type: 'array',
          items: { type: 'string' },
          description: '要处理的文件或目录（支持 .json 字幕 / .xml 弹幕 / .srt / .vtt / .ass / .txt）',
        },
        by: { type: 'string', description: '分章标签维度，逗号分隔：pos,difficulty,source,freq（默认 pos）' },
        minLen: { type: 'integer', description: '最短词长（默认 3）' },
        minFreq: { type: 'integer', description: '最低词频（默认 1）' },
      },
      additionalProperties: false,
    },
    output: textOut(
      {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          dataDir: { type: 'string' },
          runRoot: { type: 'string' },
          dataOk: { type: 'boolean' },
          missing: { type: 'array', items: { type: 'string' } },
          created: { type: 'array', items: { type: 'string' } },
          inputs: {
            type: 'array',
            items: {
              type: 'object',
              properties: { path: { type: 'string' }, exists: { type: 'boolean' }, kind: { type: 'string' }, size: { type: 'integer' } },
              required: ['path', 'exists', 'kind', 'size'],
              additionalProperties: false,
            },
          },
          params: {
            type: 'object',
            properties: {
              minLen: { type: 'integer' },
              minFreq: { type: 'integer' },
              by: { type: 'array', items: { type: 'string' } },
              samplePerWord: { type: 'integer' },
            },
            required: ['minLen', 'minFreq', 'by', 'samplePerWord'],
            additionalProperties: false,
          },
          rendered: { type: 'string' },
        },
        required: ['ok', 'dataDir', 'runRoot', 'dataOk', 'missing', 'created', 'inputs', 'params', 'rendered'],
        additionalProperties: false,
      },
      (v) => v.rendered,
    ),
    async execute(args = {}) {
      const ov = overridesOf(cfg);
      if (args.minLen != null) ov.lexicon = { ...(ov.lexicon ?? {}), minLen: Number(args.minLen) };
      if (args.minFreq != null) ov.lexicon = { ...(ov.lexicon ?? {}), minFreq: Number(args.minFreq) };
      if (args.by) ov.classify = { ...(ov.classify ?? {}), by: String(args.by).split(',').map((s) => s.trim()).filter(Boolean) };
      const base = resolveConfig({ cwd: cfg.cwd || process.cwd(), overrides: ov });
      // 只读体检：不创建文件，只报告哪些缺（真正初始化在 vocab_collect 里做）
      const created = cfg.autoInit === false ? [] : ensureData(base.dataDir);
      const next = resolveConfig({ cwd: cfg.cwd || process.cwd(), overrides: ov });

      const kindOf = (p) => {
        const ext = String(p).toLowerCase().replace(/^.*\./, '');
        if (ext === 'json') return '字幕 json';
        if (ext === 'xml') return '弹幕 xml';
        if (ext === 'srt' || ext === 'vtt' || ext === 'ass' || ext === 'ssa') return `字幕 ${ext}`;
        if (ext === 'txt') return '纯文本';
        return ext ? `未知格式 .${ext}` : '目录';
      };
      const inputs = (args.inputs ?? []).map((p) => {
        const full = resolve(String(p));
        const ok = existsSync(full);
        let size = 0;
        if (ok) {
          try { size = statSync(full).isDirectory() ? 0 : statSync(full).size; } catch { size = 0; }
        }
        return { path: full, exists: ok, kind: ok && statSync(full).isDirectory() ? '目录' : kindOf(full), size };
      });

      const missing = next.missingFiles.map((m) => `${m.key} → ${m.path}`);
      const params = {
        minLen: Number(next.lexicon?.minLen ?? 3),
        minFreq: Number(next.lexicon?.minFreq ?? 1),
        by: next.classify?.by ?? ['pos'],
        samplePerWord: Number(next.docx?.samplePerWord ?? 3),
      };
      const lines = [
        `【词汇整理｜体检】${next.dataOk ? '词表齐全' : `缺 ${missing.length} 个词表文件`}`,
        `词表目录: ${next.dataDir}`,
        `运行目录: ${next.runRoot}`,
        ...(created.length ? [`刚初始化: ${created.length} 个文件`] : []),
        ...missing.map((m) => `  ❌ ${m}`),
        '',
        `输入: ${inputs.length} 个`,
        ...inputs.map((i) => `  ${i.exists ? '✓' : '✗'} ${i.kind}  ${i.size} 字节  ${i.path}`),
        '',
        `参数: 最短词长 ${params.minLen} / 最低词频 ${params.minFreq} / 分章 ${params.by.map((d) => TAG_DIM_LABELS[d] ?? d).join(' + ')} / 每词 ${params.samplePerWord} 条样本`,
        '',
        '下一步: vocab_collect（解析抽词）→ vocab_translate（可选）→ vocab_build_docx → vocab_by_tag',
      ];
      return {
        ok: next.dataOk && inputs.every((i) => i.exists),
        dataDir: next.dataDir,
        runRoot: next.runRoot,
        dataOk: next.dataOk,
        missing,
        created,
        inputs,
        params,
        rendered: lines.join('\n'),
      };
    },
  });

  // ── 2 · 收集：解析 + 抽词 ───────────────────────────────────────────────
  tools.register({
    name: 'vocab_collect',
    description:
      '解析弹幕/字幕文件，清洗、切词、词形还原、过滤停用词与已知词、按标签分类，产出一次运行目录'
      + '（runs/<runId>/digest.json）。这一步不生成 Word —— 先用它看统计与词条，确认没问题再出文档。'
      + '支持 .json（B站字幕）/ .xml（B站弹幕）/ .srt / .vtt / .ass / .txt，目录会递归展开。',
    parameters: {
      type: 'object',
      properties: {
        inputs: { type: 'array', items: { type: 'string' }, description: '文件或目录列表（必填）' },
        runId: { type: 'string', description: '指定运行 id（默认按时间生成）。id 已存在时会报冲突，不覆盖' },
        overwrite: { type: 'boolean', description: '允许覆盖已存在的 runId 目录（默认不允许；正被其他任务占用的目录一律不许覆盖）' },
        title: { type: 'string', description: '文档标题（默认「英语词汇整理 · <输入目录名>」）' },
        language: { type: 'string', description: '分析语言：en（英文，默认）或 ja（日文，需 kuromoji）' },
        by: { type: 'string', description: '分章标签维度，逗号分隔：pos,difficulty,source,freq' },
        minLen: { type: 'integer', description: '最短词长' },
        minFreq: { type: 'integer', description: '最低词频' },
      },
      required: ['inputs'],
      additionalProperties: false,
    },
    output: textOut(
      {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          runId: { type: 'string' },
          runDir: { type: 'string' },
          digestFile: { type: 'string' },
          stats: {
            type: 'object',
            properties: {
              fileCount: { type: 'integer' },
              fragmentCount: { type: 'integer' },
              candidateCount: { type: 'integer' },
              keptCount: { type: 'integer' },
              filteredCount: { type: 'integer' },
              phraseCount: { type: 'integer' },
            },
            required: ['fileCount', 'fragmentCount', 'candidateCount', 'keptCount', 'filteredCount', 'phraseCount'],
            additionalProperties: false,
          },
          tags: {
            type: 'object',
            properties: {
              pos: { type: 'array', items: { type: 'string' } },
              difficulty: { type: 'array', items: { type: 'string' } },
              source: { type: 'array', items: { type: 'string' } },
              freq: { type: 'array', items: { type: 'string' } },
            },
            required: ['pos', 'difficulty', 'source', 'freq'],
            additionalProperties: false,
          },
          top: {
            type: 'array',
            items: {
              type: 'object',
              properties: { word: { type: 'string' }, pos: { type: 'string' }, count: { type: 'integer' } },
              required: ['word', 'pos', 'count'],
              additionalProperties: false,
            },
          },
          warnings: { type: 'array', items: { type: 'string' } },
          language: { type: 'string' },
          rendered: { type: 'string' },
        },
        required: ['ok', 'runId', 'runDir', 'digestFile', 'stats', 'tags', 'top', 'warnings', 'language', 'rendered'],
        additionalProperties: false,
      },
      (v) => v.rendered,
    ),
    async execute(args = {}) {
      const ov = overridesOf(cfg);
      if (args.language) ov.language = String(args.language);
      if (args.minLen != null) ov.lexicon = { ...(ov.lexicon ?? {}), minLen: Number(args.minLen) };
      if (args.minFreq != null) ov.lexicon = { ...(ov.lexicon ?? {}), minFreq: Number(args.minFreq) };
      if (args.by) ov.classify = { ...(ov.classify ?? {}), by: String(args.by).split(',').map((s) => s.trim()).filter(Boolean) };
      const runOpts = {
        inputs: (args.inputs ?? []).map((p) => resolve(String(p))),
        cwd: cfg.cwd || process.cwd(),
        runId: args.runId,
        overwrite: args.overwrite === true,
        title: args.title,
        configOverrides: ov,
      };
      // 日文管线需要先异步加载 kuromoji，英文仍走同步路径
      const wantJa = String(ov.language ?? '').toLowerCase() === 'ja' || String(ov.language ?? '').toLowerCase() === 'jp';
      let meta;
      try {
        meta = wantJa ? await runDigestAsync(runOpts) : runDigest(runOpts);
      } catch (e) {
        if (e.code === 'INVALID_LANGUAGE') throw new Error(`不支持的语言：${args.language}（只接受 en / ja）`);
        if (e.code === 'RUN_DIR_CONFLICT') {
          const why = e.reason === 'busy'
            ? '这个运行目录正有任务在跑，不能覆盖'
            : '这个 runId 已经有结果了；要覆盖请显式传 overwrite=true';
          throw new Error(`运行目录冲突：${e.runId ?? args.runId}（${why}）`);
        }
        throw e;
      }
      const dig = JSON.parse(readFileSync(meta.outputs.digest, 'utf8'));
      const tags = {};
      for (const dim of TAG_DIMENSIONS) {
        tags[dim] = (dig.tags?.[dim] ?? []).map((t) => `${t.label} ${t.count}`);
      }
      const top = (dig.topWords ?? []).slice(0, 15).map((w) => ({ word: w.display ?? w.word, pos: w.pos ?? '', count: w.count ?? 0 }));
      const warnings = (meta.warnings ?? []).map((w) => `${w.level}: ${w.src ? `${w.src}: ` : ''}${w.message}`);
      const lines = [
        `【词汇整理｜收集】运行 ${meta.runId}（${(meta.elapsedMs / 1000).toFixed(1)}s · 语言 ${meta.language})`,
        `  输入 ${meta.stats.fileCount} 个文件 / ${meta.stats.fragmentCount} 条片段`,
        `  收录 ${meta.stats.keptCount} 个词条，过滤 ${meta.stats.filteredCount} 个，短语 ${meta.stats.phraseCount} 个`,
        `  中间结果: ${meta.outputs.digest}`,
        '',
        '标签分布:',
        ...Object.entries(tags).map(([d, list]) => `  ${TAG_DIM_LABELS[d] ?? d}: ${list.join(' | ') || '（无）'}`),
        '',
        `高频词: ${top.map((t) => `${t.word}(${t.count})`).join(', ') || '（无）'}`,
        ...(warnings.length ? ['', '告警:', ...warnings.slice(0, 6).map((w) => `  ${w}`)] : []),
        '',
        '下一步: vocab_translate（可选，补中文释义）→ vocab_build_docx',
      ];
      logger.info(`[vocab-digest] collect ${meta.runId}: ${meta.stats.keptCount} words (${meta.language})`);
      return {
        ok: true,
        runId: meta.runId,
        runDir: meta.runDir,
        digestFile: meta.outputs.digest,
        stats: meta.stats,
        tags,
        top,
        warnings,
        language: meta.language ?? 'en',
        rendered: lines.join('\n'),
      };
    },
  });

  // ── 3 · 翻译：导出批次 / 回写 ──────────────────────────────────────────
  tools.register({
    name: 'vocab_translate',
    description:
      '给词条补中文释义与词性（LLM 翻译的场景）。mode=export 导出待翻译批次 JSON；'
      + 'mode=apply 把 {"word": {"pos":"n.","meaning":"中文释义"}} 回写到运行目录并重出 Word。'
      + '回写是幂等的：同一条重复回写不会重复累加。',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['export', 'apply'], description: 'export 导出批次 / apply 回写' },
        runId: { type: 'string', description: '运行 id（与 runDir 二选一）' },
        runDir: { type: 'string', description: '运行目录绝对路径' },
        batchSize: { type: 'integer', description: 'export 时每批词数（默认 40）' },
        batchIndex: { type: 'integer', description: 'export 时只取第几批（从 0 开始；省略=全部）' },
        decisions: {
          type: 'object',
          description: 'apply 时的回写内容 { "word": { "pos": "n.", "meaning": "释义" } } 或 { "word": "n." }',
          additionalProperties: true,
        },
        render: { type: 'boolean', description: 'apply 后是否立刻重出 Word（默认 true）' },
      },
      required: ['mode'],
      additionalProperties: false,
    },
    output: textOut(
      {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          mode: { type: 'string' },
          runId: { type: 'string' },
          runDir: { type: 'string' },
          batchFile: { type: 'string' },
          total: { type: 'integer' },
          batchCount: { type: 'integer' },
          batchIndex: { type: 'integer' },
          words: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                word: { type: 'string' }, pos: { type: 'string' }, count: { type: 'integer' }, sample: { type: 'string' },
              },
              required: ['word', 'pos', 'count', 'sample'],
              additionalProperties: false,
            },
          },
          applied: { type: 'integer' },
          docx: { type: 'string' },
          verifyOk: { type: 'boolean' },
          checks: { type: 'array', items: { type: 'string' } },
          rendered: { type: 'string' },
        },
        required: ['ok', 'mode', 'runId', 'runDir', 'batchFile', 'total', 'batchCount', 'batchIndex', 'words', 'applied', 'docx', 'verifyOk', 'checks', 'rendered'],
        additionalProperties: false,
      },
      (v) => v.rendered,
    ),
    async execute(args = {}) {
      const runDir = resolveRunDir(cfg, args.runDir, args.runId);
      if (!runDir) {
        const msg = '找不到运行目录 —— 先用 vocab_collect 生成，或传 runId / runDir';
        return {
          ok: false, mode: String(args.mode ?? ''), runId: String(args.runId ?? ''), runDir: '',
          batchFile: '', total: 0, batchCount: 0, batchIndex: -1, words: [], applied: 0,
          docx: '', verifyOk: false, checks: [msg], rendered: msg,
        };
      }
      const dig = loadRunDigest(runDir);
      const runId = String(dig.runId ?? '');

      if (args.mode === 'export') {
        const batchSize = Number(args.batchSize ?? 40);
        const decisions = existsSync(join(runDir, 'decisions.json')) ? readDecisions(join(runDir, 'decisions.json')) : {};
        const { total, batches } = batchesOf(dig, { batchSize, decisions });
        const idx = Number.isInteger(args.batchIndex) ? args.batchIndex : -1;
        const chosen = idx >= 0 ? [batches[idx] ?? []] : batches;
        const batchFile = join(runDir, `translate-batch-${idx >= 0 ? idx : 'all'}.json`);
        const payload = {
          generatedAt: localIso(), runDir, total, batchSize,
          batches: idx >= 0 ? { [idx]: chosen[0] } : batches,
        };
        // 批次文件落在运行目录里（引擎自身的 IO，不依赖 tools 服务的文件工具）
        writeFileSync(batchFile, stablePretty(payload), 'utf8');
        const words = (chosen[0] ?? []).map((w) => ({ word: w.word, pos: w.pos, count: w.count, sample: w.sample }));
        const lines = [
          `【词汇整理｜导出待翻译】${runId || runDir}`,
          `  待翻译 ${total} 个词条，共 ${batches.length} 批（每批 ${batchSize}）`,
          `  批次文件: ${batchFile}${idx >= 0 ? `（只含第 ${idx} 批，${words.length} 个词）` : ''}`,
          words.length ? `  本批词条: ${words.map((w) => `${w.word}(${w.pos})`).join(', ')}` : '  （没有待翻译的词条）',
          '',
          '回写示例: vocab_translate(mode="apply", runId="' + (runId || '<runId>') + '", decisions={"gradient": {"pos": "n.", "meaning": "梯度"}})',
        ];
        return {
          ok: true, mode: 'export', runId, runDir, batchFile, total,
          batchCount: batches.length, batchIndex: idx, words, applied: 0, docx: '', verifyOk: true,
          checks: [], rendered: lines.join('\n'),
        };
      }

      if (args.mode !== 'apply') {
        const msg = 'mode 只能是 export 或 apply';
        return {
          ok: false, mode: String(args.mode ?? ''), runId, runDir, batchFile: '', total: 0, batchCount: 0,
          batchIndex: -1, words: [], applied: 0, docx: '', verifyOk: false, checks: [msg], rendered: msg,
        };
      }

      const patch = args.decisions && typeof args.decisions === 'object' && !Array.isArray(args.decisions) ? args.decisions : {};
      const target = join(runDir, 'decisions.json');
      const current = existsSync(target) ? readDecisions(target) : {};
      const merged = { ...current, ...patch };
      writeFileSync(target, stablePretty(merged), 'utf8');

      if (args.render === false) {
        const msg = `已回写 ${Object.keys(patch).length} 条到 ${target}（未重出文档；用 vocab_build_docx 生成）`;
        return {
          ok: true, mode: 'apply', runId, runDir, batchFile: '', total: 0, batchCount: 0, batchIndex: -1,
          words: [], applied: Object.keys(patch).length, docx: '', verifyOk: true, checks: [], rendered: msg,
        };
      }

      const r = renderRun({ runDir, cwd: cfg.cwd || process.cwd(), decisions: merged, dataDirOverride: cfg.dataDir });
      const checks = r.verify.checks.filter((c) => c.status === 'fail').map((c) => `${c.id}: ${c.message}`);
      const lines = [
        `【词汇整理｜回写】${runId || runDir}`,
        `  回写 ${Object.keys(patch).length} 条，累计 ${Object.keys(merged).length} 条`,
        `  文档: ${r.docxPath}`,
        `  自检: ${r.verify.ok ? '通过' : `未通过（${checks.length} 项）`}`,
        ...checks.map((c) => `  ❌ ${c}`),
      ];
      return {
        ok: r.verify.ok, mode: 'apply', runId, runDir, batchFile: '', total: 0, batchCount: 0, batchIndex: -1,
        words: [], applied: Object.keys(patch).length, docx: r.docxPath, verifyOk: r.verify.ok,
        checks, rendered: lines.join('\n'),
      };
    },
  });

  // ── 4 · 出文档 ────────────────────────────────────────────────────────
  tools.register({
    name: 'vocab_build_docx',
    description:
      '把一次运行生成/重生成 Word 文档并跑自检（zip 可读、XML 良构、章节齐全、字数对得上、重渲染逐字节一致）。'
      + 'docFile 为空时用 digest.json 与 decisions.json 渲染；给了 docFile 则从已有的 digest 结果 JSON 渲染。'
      + 'by 可以覆盖分章标签维度（例如 "difficulty" 或 "pos,source"），实现在文档内换一种分类方式查看。',
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: '运行 id（与 runDir 二选一）' },
        runDir: { type: 'string', description: '运行目录绝对路径' },
        by: { type: 'string', description: '覆盖分章标签维度：pos / difficulty / source / freq，逗号分隔多选' },
        title: { type: 'string', description: '覆盖文档标题' },
        language: {
          type: 'string',
          enum: ['en', 'ja'],
          description: '覆盖文档语言（默认跟随这次运行的 digest.json）。只影响标题前缀、亚洲字体与语言标记，不重新分词',
        },
      },
      additionalProperties: false,
    },
    output: textOut(
      {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          runId: { type: 'string' },
          runDir: { type: 'string' },
          docx: { type: 'string' },
          bytes: { type: 'integer' },
          verifyOk: { type: 'boolean' },
          checks: {
            type: 'array',
            items: {
              type: 'object',
              properties: { id: { type: 'string' }, status: { type: 'string' }, message: { type: 'string' } },
              required: ['id', 'status', 'message'],
              additionalProperties: false,
            },
          },
          stats: {
            type: 'object',
            properties: {
              paragraphs: { type: 'integer' }, tables: { type: 'integer' }, heading1: { type: 'integer' },
              heading2: { type: 'integer' }, bullets: { type: 'integer' }, entries: { type: 'integer' }, chars: { type: 'integer' },
            },
            required: ['paragraphs', 'tables', 'heading1', 'heading2', 'bullets', 'entries', 'chars'],
            additionalProperties: false,
          },
          documentXmlSha256: { type: 'string' },
          rendered: { type: 'string' },
        },
        required: ['ok', 'runId', 'runDir', 'docx', 'bytes', 'verifyOk', 'checks', 'stats', 'documentXmlSha256', 'rendered'],
        additionalProperties: false,
      },
      (v) => v.rendered,
    ),
    async execute(args = {}) {
      const runDir = resolveRunDir(cfg, args.runDir, args.runId);
      if (!runDir) {
        const msg = '找不到运行目录 —— 先用 vocab_collect 生成';
        return {
          ok: false, runId: '', runDir: '', docx: '', bytes: 0, verifyOk: false, checks: [],
          stats: { paragraphs: 0, tables: 0, heading1: 0, heading2: 0, bullets: 0, entries: 0, chars: 0 },
          documentXmlSha256: '', rendered: msg,
        };
      }
      const configOverrides = overridesOf(cfg);
      if (args.by) configOverrides.classify = { ...(configOverrides.classify ?? {}), by: String(args.by).split(',').map((s) => s.trim()).filter(Boolean) };
      // language 只改文档呈现（标题前缀 / eastAsia 字体 / w:lang），不动分词结果
      if (args.language) configOverrides.language = String(args.language);

      const r = renderRun({
        runDir,
        cwd: cfg.cwd || process.cwd(),
        dataDirOverride: cfg.dataDir,
        configOverrides: (args.by || args.language) ? configOverrides : undefined,
        title: args.title,
      });
      const dig = JSON.parse(readFileSync(join(runDir, 'digest.json'), 'utf8'));
      const bytes = existsSync(r.docxPath) ? statSync(r.docxPath).size : 0;
      const checks = r.verify.checks.map((c) => ({ id: c.id, status: c.status, message: c.message }));
      const failed = checks.filter((c) => c.status === 'fail');
      const lines = [
        `【词汇整理｜出文档】${dig.runId ?? runDir}`,
        `  文档: ${r.docxPath}（${(bytes / 1024).toFixed(1)} KB）`,
        `  结构: ${r.verify.stats.entries} 个词条 / ${r.verify.stats.heading1} 章 / ${r.verify.stats.tables} 张表`,
        `  自检: ${r.verify.ok ? '全部通过' : `未通过（${failed.length} 项）`}`,
        ...checks.map((c) => `  [${c.status === 'pass' ? 'OK' : 'FAIL'}] ${c.id}: ${c.message}`),
        '',
        `指纹: ${r.verify.documentXmlSha256.slice(0, 16)}…（同输入重跑应一致）`,
      ];
      return {
        ok: r.verify.ok,
        runId: String(dig.runId ?? ''),
        runDir,
        docx: r.docxPath,
        bytes,
        verifyOk: r.verify.ok,
        checks,
        stats: r.verify.stats,
        documentXmlSha256: r.verify.documentXmlSha256,
        rendered: lines.join('\n'),
      };
    },
  });

  // ── 5 · 按标签查看 ────────────────────────────────────────────────────
  tools.register({
    name: 'vocab_by_tag',
    description:
      '按标签查看词汇：dim 选择分组维度（词性/难度/来源/频次），tag 只看某个标签（如 "difficulty:basic"）。'
      + 'output=txt 导出可读清单；output=docx 用这个标签维度重新生成一份 Word（等于换一种分类方式看同一批词）。'
      + '标签值可先用 vocab_collect 的 tags 字段查。',
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: '运行 id（与 runDir 二选一）' },
        runDir: { type: 'string', description: '运行目录绝对路径' },
        dim: { type: 'string', enum: TAG_DIMENSIONS, description: '分组维度，默认 pos' },
        tag: { type: 'string', description: '只看某个标签，格式 "维度:值"，如 difficulty:basic、source:lecture.srt' },
        output: { type: 'string', enum: ['txt', 'docx', 'both'], description: '输出形式，默认 txt' },
      },
      additionalProperties: false,
    },
    output: textOut(
      {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          runId: { type: 'string' },
          runDir: { type: 'string' },
          dim: { type: 'string' },
          tag: { type: 'string' },
          itemCount: { type: 'integer' },
          groups: {
            type: 'array',
            items: {
              type: 'object',
              properties: { label: { type: 'string' }, count: { type: 'integer' } },
              required: ['label', 'count'],
              additionalProperties: false,
            },
          },
          txtFile: { type: 'string' },
          docx: { type: 'string' },
          preview: { type: 'string' },
          rendered: { type: 'string' },
        },
        required: ['ok', 'runId', 'runDir', 'dim', 'tag', 'itemCount', 'groups', 'txtFile', 'docx', 'preview', 'rendered'],
        additionalProperties: false,
      },
      (v) => v.rendered,
    ),
    async execute(args = {}) {
      const runDir = resolveRunDir(cfg, args.runDir, args.runId);
      if (!runDir) {
        const msg = '找不到运行目录 —— 先用 vocab_collect 生成';
        return {
          ok: false, runId: '', runDir: '', dim: String(args.dim ?? 'pos'), tag: String(args.tag ?? ''),
          itemCount: 0, groups: [], txtFile: '', docx: '', preview: '', rendered: msg,
        };
      }
      const dim = TAG_DIMENSIONS.includes(args.dim) ? args.dim : 'pos';
      const dig = loadRunDigest(runDir);
      const items = filterItems(dig.items ?? [], { tag: args.tag ?? '' });
      const mode = args.output ?? 'txt';
      const groups = (() => {
        const m = new Map();
        for (const it of items) {
          const t = it.pos ?? 'other';
          m.set(t, (m.get(t) ?? 0) + 1);
        }
        return [...m.entries()].map(([k, n]) => ({ label: k, count: n }));
      })();

      let txtFile = '';
      let docx = '';
      if (mode === 'txt' || mode === 'both') {
        const r = exportTagView(runDir, dig, { dim, filter: { tag: args.tag ?? '' } });
        txtFile = r.file;
      }
      if (mode === 'docx' || mode === 'both') {
        const ov = overridesOf(cfg);
        ov.classify = { ...(ov.classify ?? {}), by: [dim] };
        const r = renderRun({ runDir, cwd: cfg.cwd || process.cwd(), dataDirOverride: cfg.dataDir, configOverrides: ov });
        docx = r.docxPath;
      }
      const preview = txtFile && existsSync(txtFile) ? readFileSync(txtFile, 'utf8').split('\n').slice(0, 24).join('\n') : '';
      const lines = [
        `【词汇整理｜按标签查看】${dig.runId ?? runDir}`,
        `  维度 ${TAG_DIM_LABELS[dim] ?? dim}${args.tag ? ` · 只看 ${args.tag}` : ''} · ${items.length} 个词条`,
        ...(txtFile ? [`  清单: ${txtFile}`] : []),
        ...(docx ? [`  文档: ${docx}（按「${TAG_DIM_LABELS[dim] ?? dim}」分章）`] : []),
        '',
        preview ? tail(preview, 1200) : '（清单为空）',
      ];
      return {
        ok: true, runId: String(dig.runId ?? ''), runDir, dim, tag: String(args.tag ?? ''),
        itemCount: items.length, groups, txtFile, docx, preview, rendered: lines.join('\n'),
      };
    },
  });

  // ── 6 · 状态 ──────────────────────────────────────────────────────────
  tools.register({
    name: 'vocab_status',
    description: '查看词表目录状态与历史运行（每次运行的词条数、自检结果、文档路径）。',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', description: '最多列几条（默认 10）' } },
      additionalProperties: false,
    },
    output: textOut(
      {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          dataDir: { type: 'string' },
          dataOk: { type: 'boolean' },
          missing: { type: 'array', items: { type: 'string' } },
          runs: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                runId: { type: 'string' }, runDir: { type: 'string' }, generatedAt: { type: 'string' },
                keptCount: { type: 'integer' }, ok: { type: 'boolean' }, docx: { type: 'string' },
              },
              required: ['runId', 'runDir', 'generatedAt', 'keptCount', 'ok', 'docx'],
              additionalProperties: false,
            },
          },
          rendered: { type: 'string' },
        },
        required: ['ok', 'dataDir', 'dataOk', 'missing', 'runs', 'rendered'],
        additionalProperties: false,
      },
      (v) => v.rendered,
    ),
    async execute(args = {}) {
      const cwd = cfg.cwd || process.cwd();
      const base = resolveConfig({ cwd, overrides: overridesOf(cfg) });
      const created = ensureData(base.dataDir);
      const next = resolveConfig({ cwd, overrides: overridesOf(cfg) });
      const limit = Math.max(1, Math.min(200, Number(args.limit ?? 10)));
      const runs = listRuns({ cwd, dataDirOverride: cfg.dataDir }).slice(0, limit).map((r) => ({
        runId: r.runId, runDir: r.runDir, generatedAt: String(r.generatedAt ?? ''),
        keptCount: Number(r.keptCount ?? 0), ok: Boolean(r.ok), docx: r.docx,
      }));
      const missing = next.missingFiles.map((m) => `${m.key} → ${m.path}`);
      const lines = [
        `【词汇整理｜状态】`,
        `  词表目录: ${next.dataDir}（${next.dataOk ? '齐全' : `缺 ${missing.length} 个`}）`,
        ...(created.length ? [`  本次自动初始化: ${created.length} 个文件`] : []),
        ...missing.map((m) => `  ❌ ${m}`),
        `  历史运行: ${runs.length} 次`,
        ...runs.map((r) => `  ${r.runId || '(未命名)'}  词条 ${r.keptCount}  ${r.ok ? '自检通过' : '自检未通过'}`),
      ];
      return {
        ok: next.dataOk, dataDir: next.dataDir, dataOk: next.dataOk, missing, runs,
        rendered: lines.join('\n'),
      };
    },
  });

  // ── 7 · 语音转写 ──────────────────────────────────────────────────────
  tools.register({
    name: 'vocab_transcribe',
    description:
      '把音频/视频转成 srt 字幕（ffmpeg 内置 whisper，本机 GPU 约 4~9 倍实时），供 vocab_collect 当输入。'
      + '视频没有 CC 字幕、或者只想要口播内容时用这个；模型默认 models/ggml-small.bin。',
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: '音频或视频文件路径（mp4/m4s/mkv/mp3/wav…）' },
        out: { type: 'string', description: '输出 srt 路径，默认与原文件同名 .srt' },
        language: { type: 'string', description: '语言代码，默认 en' },
        start: { type: 'number', description: '只转这一段，起点秒' },
        duration: { type: 'number', description: '只转这一段，时长秒' },
        gpu: { type: 'boolean', description: '是否用 GPU，默认 true' },
        model: { type: 'string', description: '模型文件名或路径，默认 ggml-small.bin' },
        timeoutMs: { type: 'number', description: '超时毫秒数（默认按 duration 估算，未给则 30 分钟）' },
        overwrite: { type: 'boolean', description: '允许覆盖已存在的同名字幕（默认不允许：已有字幕直接报冲突，旧文件原样保留）' },
      },
      required: ['input'],
      additionalProperties: false,
    },
    output: textOut(
      {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          input: { type: 'string' },
          out: { type: 'string' },
          model: { type: 'string' },
          language: { type: 'string' },
          gpu: { type: 'boolean' },
          bytes: { type: 'integer' },
          elapsedMs: { type: 'integer' },
          rendered: { type: 'string' },
        },
        required: ['ok', 'input', 'out', 'model', 'language', 'gpu', 'bytes', 'elapsedMs', 'rendered'],
        additionalProperties: false,
      },
      (v) => v.rendered,
    ),
    async execute(args = {}) {
      const cwd = cfg.cwd || process.cwd();
      const input = resolve(cwd, String(args.input));
      // 异步子进程：长时间转写期间工具调用方（DSH/Web）仍然能响应探活
      let r;
      try {
        r = await transcribe({
          input,
          out: args.out ? resolve(cwd, String(args.out)) : undefined,
          language: args.language ? String(args.language) : 'en',
          start: args.start != null ? Number(args.start) : undefined,
          duration: args.duration != null ? Number(args.duration) : undefined,
          gpu: args.gpu !== false,
          model: args.model ? String(args.model) : cfg.model,
          cwd,
          timeoutMs: args.timeoutMs != null ? Number(args.timeoutMs) : undefined,
          overwrite: args.overwrite === true,
        });
      } catch (e) {
        // 明确错误码：调用方据此给处置建议，不要只说「失败了」
        throw new Error(`${e.messageZh ?? '转写失败'}（${e.code ?? 'UNKNOWN'}）：${e.message}`);
      }
      const lines = [
        '【词汇整理｜语音转写】',
        `  输入: ${r.input}`,
        `  字幕: ${r.out}（${(r.bytes / 1024).toFixed(1)} KB）`,
        `  耗时: ${(r.elapsedMs / 1000).toFixed(0)} 秒（模型 ${basename(r.model)}，${r.gpu ? 'GPU' : 'CPU'}）`,
        '',
        '下一步: 用 vocab_collect，inputs 传这个 srt。',
      ];
      return {
        ok: true, input: r.input, out: r.out, model: r.model, language: r.language,
        gpu: Boolean(r.gpu), bytes: r.bytes, elapsedMs: r.elapsedMs, rendered: lines.join('\n'),
      };
    },
  });

  // ── 8 · 从 B 站取数 ───────────────────────────────────────────────────
  tools.register({
    name: 'vocab_fetch',
    description:
      '从 B 站视频取数：有 CC 字幕就下字幕，没有就自动下音频跑 whisper 转写；弹幕单独存文件（默认不进分析，'
      + '因为弹幕是观众吐槽、会把游戏梗冲上词频榜；确实要一起分析时把 withDanmaku 设 true）。'
      + '输出目录 samples/<bvid>.p<页>/，返回的 inputs 直接喂给 vocab_collect。',
    parameters: {
      type: 'object',
      properties: {
        link: { type: 'string', description: 'B 站视频地址、BV 号或 av 号（可带 ?p=2 分 P）' },
        page: { type: 'integer', description: '分 P 序号，默认按链接/1' },
        withDanmaku: { type: 'boolean', description: '弹幕是否也当分析输入，默认 false（只存不用）' },
        fetchDanmaku: { type: 'boolean', description: '是否下载弹幕文件，默认 true（设 false 就完全不取弹幕）' },
        asr: { type: 'boolean', description: '没有字幕时是否自动语音识别，默认 true' },
        model: { type: 'string', description: '语音识别模型文件名或路径，默认 ggml-small.bin' },
        out: { type: 'string', description: '输出目录（默认 samples/<bvid>.p<页>）' },
      },
      required: ['link'],
      additionalProperties: false,
    },
    output: textOut(
      {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          bvid: { type: 'string' },
          title: { type: 'string' },
          outDir: { type: 'string' },
          subtitle: { type: 'integer' },
          danmaku: { type: 'integer' },
          asrSeconds: { type: 'number' },
          inputs: { type: 'array', items: { type: 'string' } },
          rendered: { type: 'string' },
        },
        required: ['ok', 'bvid', 'title', 'outDir', 'subtitle', 'danmaku', 'asrSeconds', 'inputs', 'rendered'],
        additionalProperties: false,
      },
      (v) => v.rendered,
    ),
    async execute(args = {}) {
      const cwd = cfg.cwd || process.cwd();
      const { fetchVideo } = await import('./fetch.js');
      const logs = [];
      const r = await fetchVideo({
        link: String(args.link ?? ''),
        cwd,
        page: args.page != null ? Number(args.page) : undefined,
        fetchDanmaku: args.fetchDanmaku !== false,
        asr: args.asr !== false,
        withDanmaku: args.withDanmaku === true,
        model: args.model ? String(args.model) : cfg.model,
        // 语言必须一路传到转写：不传的话 fetchVideo 会按 en 转日语人声，产出英文 SRT，
        // 再交给日文分词就是 0 个词条（2026-11-11 用 BV1KE4p6CERE 复现过）
        language: args.language ? String(args.language) : cfg.language,
        outDir: args.out ? resolve(cwd, String(args.out)) : undefined,
        log: (m) => logs.push(String(m)),
      });
      if (!r.ok) {
        const lines = ['【词汇整理｜取数失败】', `  ${r.error ?? '未知错误'}`, ...logs.map((l) => `  · ${l}`)];
        return {
          ok: false, bvid: '', title: '', outDir: '', subtitle: 0, danmaku: 0, asrSeconds: 0,
          inputs: [], rendered: lines.join('\n'),
        };
      }
      const dmText = r.danmakuInfo?.ok
        ? `${r.danmaku} 条${r.withDanmaku ? '（已参与分析）' : '（只保存不参与分析）'}${r.danmakuInfo.warning ? ` ⚠ ${r.danmakuInfo.warning}` : ''}`
        : `未取到（${r.danmakuInfo?.error ?? '已跳过'}）`;
      const lines = [
        '【词汇整理｜B 站取数】',
        `  视频: ${r.info?.title ?? ''}（${r.info?.bvid ?? ''} 第 ${r.page}/${r.totalPages} P${r.pageTitle ? ` · ${r.pageTitle}` : ''}）`,
        `  目录: ${r.dir}`,
        `  跳转: ${r.playUrl}`,
        `  字幕 ${r.subtitle} 条 · 弹幕 ${dmText}${r.asr ? ` · 语音识别 ${r.asr.seconds}s` : ''}`,
        '',
        '下一步: vocab_collect，inputs 传下面这些文件（都是真实存在的路径）。',
        ...(r.inputs ?? []).map((p) => `  ${p}`),
      ];
      return {
        ok: true, bvid: String(r.info?.bvid ?? ''), title: String(r.info?.title ?? ''),
        outDir: r.dir, subtitle: Number(r.subtitle ?? 0), danmaku: Number(r.danmaku ?? 0),
        asrSeconds: Number(r.asr?.seconds ?? 0), inputs: (r.inputs ?? []).map(String),
        rendered: lines.join('\n'),
      };
    },
  });

  // ── 9 · 词表管理 ──────────────────────────────────────────────────────
  tools.register({
    name: 'vocab_wordlist',
    description:
      '自建词表：一个视频配一张表。action=list 列出全部；create/rename 新建或重命名（rename 用 id+name）；'
      + 'activate 设为当前；import 导入你已有的词表文本（词条行→词性行→中文释义行）；'
      + 'fromRun 把某次运行的词条收进词表；add 手动加词；digestFrom 用某张词表的释义去整理输入（最常用）；'
      + 'export 导出成文本。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'create', 'rename', 'activate', 'import', 'fromRun', 'add', 'digestFrom', 'export'],
          description: '要执行的动作',
        },
        id: { type: 'string', description: '词表 id（list 里能看到）' },
        name: { type: 'string', description: '新建/重命名用的名字' },
        file: { type: 'string', description: 'import 时导入的词表文本路径' },
        out: { type: 'string', description: 'export 的输出路径' },
        runId: { type: 'string', description: 'fromRun 用的运行 id' },
        inputs: {
          type: 'array',
          items: { type: 'string' },
          description: 'digestFrom 的输入文件/目录（字幕 srt/json、弹幕 xml 等）',
        },
        title: { type: 'string', description: 'digestFrom 的文档标题' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: textOut(
      {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          dataDir: { type: 'string' },
          lists: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' }, name: { type: 'string' },
                count: { type: 'integer' }, active: { type: 'boolean' },
              },
              required: ['id', 'name', 'count', 'active'],
              additionalProperties: false,
            },
          },
          listId: { type: 'string' },
          runId: { type: 'string' },
          docx: { type: 'string' },
          message: { type: 'string' },
          rendered: { type: 'string' },
        },
        required: ['ok', 'action', 'dataDir', 'lists', 'listId', 'runId', 'docx', 'message', 'rendered'],
        additionalProperties: false,
      },
      (v) => v.rendered,
    ),
    async execute(args = {}) {
      const cwd = cfg.cwd || process.cwd();
      const action = String(args.action ?? 'list');
      const base = resolveConfig({ cwd, overrides: overridesOf(cfg) });
      ensureData(base.dataDir);
      const config = resolveConfig({ cwd, overrides: overridesOf(cfg) });
      const store = new WordlistStore(config.dataDir);
      store.ensure();
      const out = {
        ok: true, action, dataDir: config.dataDir, lists: [], listId: '', runId: '', docx: '', message: '',
      };

      const listNow = () => {
        const idx = store.index();
        return store.list().map((m) => ({
          id: m.id, name: m.name, count: Number(m.count ?? 0), active: m.id === idx.activeId,
        }));
      };

      if (action === 'list') {
        out.message = '词表清单';
      } else if (action === 'create') {
        const m = store.create({ name: String(args.name ?? '新词表') });
        out.listId = m.id;
        out.message = `已新建「${m.name}」`;
      } else if (action === 'rename') {
        const m = store.rename(String(args.id), String(args.name ?? ''));
        out.listId = m.id;
        out.message = `已重命名为「${m.name}」`;
      } else if (action === 'activate') {
        store.setActive(String(args.id));
        out.listId = String(args.id);
        out.message = '已切换当前词表';
      } else if (action === 'import') {
        const r = store.importFile({ file: resolve(cwd, String(args.file ?? '')), name: args.name ? String(args.name) : undefined });
        out.listId = r.id;
        out.message = `已导入「${r.name}」${r.cards ?? 0} 条词条`;
      } else if (action === 'fromRun') {
        const r = wordlistFromRun(store, String(args.runId ?? ''), { name: args.name ? String(args.name) : undefined, listId: args.id ? String(args.id) : undefined });
        out.listId = String(r.id ?? r.listId ?? '');
        out.message = `已从运行 ${args.runId} 建表「${r.name}」`;
      } else if (action === 'add') {
        const word = String(args.name ?? '').trim().toLowerCase();
        if (!word) {
          out.ok = false;
          out.message = 'add 需要 name 传单词';
        } else {
          await Promise.resolve(store.addCards(String(args.id), [{ word, display: word, kind: 'word', senses: [] }]));
          out.listId = String(args.id);
          out.message = `已把 ${word} 加入词表`;
        }
      } else if (action === 'digestFrom') {
        const inputs = (args.inputs ?? []).map((p) => resolve(cwd, String(p)));
        const r = runDigest({
          cwd, inputs, wordlist: args.id ? String(args.id) : undefined,
          title: args.title ? String(args.title) : undefined,
          dataDirOverride: cfg.dataDir, localConfigPath: undefined,
          configOverrides: overridesOf(cfg),
        });
        out.runId = r.runId;
        out.docx = r.outputs?.docx ?? '';
        out.message = `运行 ${r.runId} 完成：${r.stats?.keptCount ?? 0} 个词条，自检${r.verify?.ok ? '通过' : '未通过'}`;
      } else if (action === 'export') {
        const r = store.exportText(String(args.id), resolve(cwd, String(args.out ?? '词表导出.txt')));
        out.listId = String(args.id);
        out.message = `已导出 ${r.count} 条`;

      } else {
        out.ok = false;
        out.message = `不认识的 action：${action}`;
      }

      out.lists = listNow();
      const lines = [
        '【词汇整理｜词表】',
        `  ${out.message}`,
        `  词表目录: ${out.dataDir}`,
        ...out.lists.map((l) => `  ${l.active ? '★' : ' '} ${l.name}（${l.id}）${l.count} 条`),
        ...(out.runId ? [`  运行: ${out.runId}`, ...(out.docx ? [`  文档: ${out.docx}`] : [])] : []),
      ];
      out.rendered = lines.join('\n');
      return out;
    },
  });

  logger.info(`[vocab-digest] 已注册 9 个工具（词表目录: ${resolveConfig({ cwd: cfg.cwd || process.cwd(), overrides: overridesOf(cfg) }).dataDir}）`);
}
