/**
 * 命令行入口：vocab-english <命令> [选项] [输入...]
 *
 *   init                       初始化 data/ 词表
 *   digest <文件|目录...>       解析 → 生成 docx → 自检（一条龙）
 *   render --run <runDir>      只重出 docx（改完 decisions.json 用）
 *   translate [runId]          导出待翻译批次（给 LLM / 人工）
 *   apply --run <runDir> <json> 回写词性与释义后重出文档
 *   report [runId]             查看自检报告
 *   status                     列出历史运行与词表状态
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { prepareConfig, readDecisions, renderRun, runDigest, runDigestAsync, listRuns } from './run.js';
import { exportTagView, loadRunDigest, renderTagView, writeTranslateBatches } from './export.js';
import { checkWhisper, resolveModel, transcribeSync } from './asr.js';
import { fetchVideo } from './fetch.js';
import { stablePretty } from './util.js';
import { parseArgs } from './cli-args.js';

const USAGE = `用法：vocab-english <命令> [选项] [输入...]

命令：
  init                        初始化 data/ 词表（已存在则跳过）
  digest <文件|目录...>        一条龙：解析 → 生成 Word → 自检
  render --run <runDir>       只重新生成 docx（改完 decisions.json 用）
  by-tag [runId]             按标签导出可读清单（--dim / --tag / --pos / --difficulty / --source / --freq）
  translate [runId]           导出待翻译批次 JSON
  apply --run <runDir> <json> 把词性/释义回写后重新生成文档
  report [runId]              查看自检报告
  status                      列出历史运行与词表状态
  transcribe <音视频...>      用 whisper 把音频/视频转成 srt 字幕（读不了的素材先走这步）
  fetch <B站链接>             从视频取字幕 / 弹幕，并生成干净的字幕文本（取不到字幕就转音频识别）

选项：
  --cwd <dir>        工作目录（默认当前目录）
  --data-dir <dir>   词表目录（默认 <cwd>/data）
  --run-id <id>      指定运行 id
  --run <runDir>     render / apply 指定的运行目录
  --min-len <n>      最短词长（默认 3）
  --min-freq <n>     最低词频（默认 1）
  --title <s>        文档标题
  --by <dims>        分章标签维度，逗号分隔：pos,difficulty,source,freq（默认 pos）
  --dim <dim>        by-tag 按哪个维度分组（默认 pos）
  --tag <dim:value>  by-tag 只看某个标签，如 difficulty:basic
  --pos/--difficulty/--source/--freq  by-tag 的等价过滤写法
  --batch <n>        translate 单批词数（默认 40）
  --wordlist <id>    digest 用哪张词表（把它的释义并进来，并过滤掉已掌握的词）
  --out <srt>        transcribe 输出路径（默认同目录同名 .srt）
  --model <name>     whisper 模型（默认 ggml-small.bin，放在 models/ 下）
  --language <code>  transcribe 语言 / digest 分析语言（en 或 ja，默认 en）
  --start/--duration transcribe 只转一段（秒）
  --no-gpu           transcribe 强制走 CPU
  --page <n>         fetch 取第几个分 P（默认 1）
  --no-danmaku       fetch 不下载弹幕（两个开关的第一个）
  --with-danmaku     fetch 把下载到的弹幕也交给 digest（默认只保存不分析，第二个开关）
  --concurrency N    弹幕分片并发上限（默认 4）
  --no-asr           fetch 取不到字幕时不转音频识别，直接报错
  --json             以 JSON 输出（给程序调用）
`;

function out(human, payload, asJson) {
  if (asJson) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else if (human != null) process.stdout.write(`${typeof human === 'string' ? human : stablePretty(human)}\n`);
}

function configOverrides(args) {
  const o = {};
  if (args['min-len'] != null) o.lexicon = { ...(o.lexicon ?? {}), minLen: Number(args['min-len']) };
  if (args['min-freq'] != null) o.lexicon = { ...(o.lexicon ?? {}), minFreq: Number(args['min-freq']) };
  if (args.by != null) o.classify = { ...(o.classify ?? {}), by: String(args.by).split(',').map((s) => s.trim()).filter(Boolean) };
  return o;
}

/** 语言参数：缺省交给配置；非法值由 normalizeLanguage 抛 INVALID_LANGUAGE */
function languageOf(args) {
  return args.lang ?? args.language ?? undefined;
}

/** 从参数里收集 by-tag 的过滤条件 */
function tagFilterOf(args) {
  const f = {};
  if (args.tag) f.tag = String(args.tag);
  for (const k of ['pos', 'difficulty', 'source', 'freq']) {
    if (args[k]) f[k] = String(args[k]);
  }
  return f;
}

function runsRoot(cwd, args) {
  const { config } = prepareConfig({ cwd, initData: false, dataDirOverride: args['data-dir'] });
  return config.runRoot;
}

function findRunDir(cwd, args, runId) {
  if (args.run) return resolve(cwd, args.run);
  const root = runsRoot(cwd, args);
  if (!runId) return null;
  const p = join(root, runId);
  return existsSync(p) ? p : null;
}

export async function main(argv = process.argv.slice(2)) {
  const { cmd, positional, args } = parseArgs(argv);
  const asJson = Boolean(args.json);
  const cwd = args.cwd ? resolve(String(args.cwd)) : process.cwd();

  try {
    switch (cmd) {
      case 'fetch': {
        const link = positional[0];
        if (!link) {
          out(USAGE, { error: 'missing-link' }, asJson);
          return 2;
        }
        const r = await fetchVideo({
          link,
          cwd,
          page: args.page ? Number(args.page) : undefined,
          // 抓不抓弹幕 / 抓到的弹幕用不用，是两个开关
          fetchDanmaku: !args['no-danmaku'],
          withDanmaku: Boolean(args['with-danmaku']),
          asr: args['no-asr'] ? false : true,
          model: args.model,
          language: languageOf(args),
          concurrency: args.concurrency ? Number(args.concurrency) : undefined,
          log: (m) => {
            if (!asJson) process.stderr.write(`  · ${m}\n`);
          },
        });
        if (!r.ok) {
          out(`取数失败：${r.error}`, { ok: false, error: r.error, dir: r.dir, danmaku: r.danmaku }, asJson);
          return 4;
        }
        const dmNote = r.danmakuInfo?.ok
          ? `${r.danmaku} 条${r.withDanmaku ? '（已参与分析）' : '（只保存不参与分析）'}${r.danmakuInfo.warning ? ` ⚠ ${r.danmakuInfo.warning}` : ''}`
          : `失败：${r.danmakuInfo?.error ?? '未抓取'}`;
        const human = [
          `已取到：《${r.info.title}》 第 ${r.page}/${r.totalPages} P`,
          `  目录：${r.dirRel}`,
          `  台词 ${r.subtitle} 条${r.asr ? ` · 语音识别 ${r.asr.seconds}s` : ''} · 弹幕 ${dmNote}`,
          `  跳转：${r.playUrl}`,
          ...(r.inputsRel.length ? [`  下一步：vocab-english digest ${r.inputsRel.join(' ')}`] : []),
        ].join('\n');
        out(human, r, asJson);
        return 0;
      }

      case 'init': {
        const { config, createdFiles } = prepareConfig({ cwd, dataDirOverride: args['data-dir'], language: languageOf(args) });
        const human = createdFiles.length
          ? `已初始化词表（${config.language}）：\n${createdFiles.map((f) => `  + ${f}`).join('\n')}`
          : `词表已存在，未改动：${config.dataDir}`;
        out(human, { dataDir: config.dataDir, language: config.language, created: createdFiles, missing: config.missingFiles }, asJson);
        return 0;
      }

      case 'digest': {
        if (!positional.length) {
          out(USAGE, { error: 'missing-input' }, asJson);
          return 2;
        }
        const lang = languageOf(args);
        const metaOpts = {
          inputs: positional.map((p) => resolve(cwd, p)),
          cwd,
          runId: args['run-id'],
          // 显式给 --force 才允许覆盖已有的运行目录；默认冲突即停
          overwrite: args.force === true,
          title: args.title,
          wordlist: args.wordlist,
          dataDirOverride: args['data-dir'],
          language: lang,
          configOverrides: configOverrides(args),
        };
        // 日文要先加载分词器（异步），走 Async 版；英文保持原有同步路径不变
        let meta;
        try {
          meta = lang === 'ja' ? await runDigestAsync(metaOpts) : runDigest(metaOpts);
        } catch (e) {
          if (e.code === 'RUN_DIR_CONFLICT') {
            const why = e.reason === 'busy'
              ? '这个运行目录正有任务在跑，不能覆盖'
              : '这个 runId 已经有结果了；要用 --force 才覆盖';
            out(`运行目录冲突：${e.runId ?? args['run-id']}（${why}）`, { error: 'run-dir-conflict', runId: e.runId }, asJson);
            return 2;
          }
          if (e.code === 'INVALID_LANGUAGE') {
            out(e.message, { error: 'invalid-language' }, asJson);
            return 2;
          }
          throw e;
        }
        const human = [
          `运行 ${meta.runId} 完成（${(meta.elapsedMs / 1000).toFixed(1)}s，语言 ${meta.language}）`,
          `  输入 ${meta.stats.fileCount} 个文件 / ${meta.stats.fragmentCount} 条片段`,
          `  收录 ${meta.stats.keptCount} 个词条，过滤 ${meta.stats.filteredCount} 个${meta.stats.phraseCount ? `，短语 ${meta.stats.phraseCount}` : ''}`,
          `  文档 ${meta.outputs.docx}`,
          `  自检 ${meta.verify.ok ? '通过' : `未通过（${meta.verify.failed.length} 项）`}`,
          ...meta.warnings.slice(0, 5).map((w) => `  ${w.level}: ${w.src ? `${w.src}: ` : ''}${w.message}`),
        ].join('\n');
        out(human, meta, asJson);
        return meta.verify.ok ? 0 : 1;
      }

      case 'render': {
        const runDir = findRunDir(cwd, args, args['run-id'] ?? positional[0]);
        if (!runDir) { out('找不到运行目录，请用 --run <runDir>', { error: 'run-not-found' }, asJson); return 2; }
        const r = renderRun({ runDir, cwd, dataDirOverride: args['data-dir'] });
        out(`已重新生成：${r.docxPath}\n自检 ${r.verify.ok ? '通过' : '未通过'}`,
          { docx: r.docxPath, verify: r.verify }, asJson);
        return r.verify.ok ? 0 : 1;
      }

      case 'by-tag': {
        const runDir = findRunDir(cwd, args, args['run-id'] ?? positional[0]);
        if (!runDir) { out('找不到运行目录，请用 --run <runDir> 或 runId', { error: 'run-not-found' }, asJson); return 2; }
        const dim = String(args.dim ?? 'pos');
        const filter = tagFilterOf(args);
        const dig = loadRunDigest(runDir);
        const r = exportTagView(runDir, dig, { dim, filter });
        const text = renderTagView(dig, { dim, filter });
        out(`${text}\n\n已写出：${r.file}`, { file: r.file, dim, filter, items: r.items, text }, asJson);
        return 0;
      }

      case 'translate': {
        const runDir = findRunDir(cwd, args, positional[0]);
        if (!runDir) { out('找不到运行目录', { error: 'run-not-found' }, asJson); return 2; }
        const dig = loadRunDigest(runDir);
        const decisions = existsSync(join(runDir, 'decisions.json')) ? readDecisions(join(runDir, 'decisions.json')) : {};
        const batchSize = Number(args.batch ?? 40);
        const r = writeTranslateBatches(runDir, dig, { batchSize, decisions });
        const human = [
          `待翻译 ${r.total} 个词条，分 ${r.batchCount} 批（每批 ${batchSize}）`,
          `批次文件：${r.file}`,
          '把每批交给翻译，回写成 {"word": {"pos": "n.", "meaning": "中文释义"}} 后：',
          `  vocab-english apply --run "${runDir}" <回写.json>`,
        ].join('\n');
        out(human, { file: r.file, total: r.total, batchCount: r.batchCount, batches: r.batches }, asJson);
        return 0;
      }

      case 'apply': {
        const runDir = findRunDir(cwd, args, positional[0]);
        const decisionFile = positional[1] ?? args.decisions;
        if (!runDir || !decisionFile) {
          out('用法：vocab-english apply --run <runDir> <回写.json>', { error: 'bad-args' }, asJson);
          return 2;
        }
        const patch = readDecisions(resolve(cwd, decisionFile));
        const target = join(runDir, 'decisions.json');
        const current = existsSync(target) ? readDecisions(target) : {};
        const merged = { ...current, ...patch };
        writeFileSync(target, stablePretty(merged), 'utf8');
        const r = renderRun({ runDir, cwd, decisions: merged, dataDirOverride: args['data-dir'] });
        out(`已回写 ${Object.keys(patch).length} 条并重新生成：${r.docxPath}\n自检 ${r.verify.ok ? '通过' : '未通过'}`,
          { decisions: merged, docx: r.docxPath, verify: r.verify }, asJson);
        return r.verify.ok ? 0 : 1;
      }

      case 'report': {
        const runDir = findRunDir(cwd, args, positional[0]);
        if (!runDir) { out('找不到运行目录', { error: 'run-not-found' }, asJson); return 2; }
        const rep = JSON.parse(readFileSync(join(runDir, 'report.json'), 'utf8'));
        const human = [
          `自检：${rep.ok ? '全部通过' : '有失败项'}（${rep.checks.filter((c) => c.status === 'pass').length}/${rep.checks.length}）`,
          ...rep.checks.map((c) => `  [${c.status === 'pass' ? 'OK' : 'FAIL'}] ${c.id}: ${c.message}`),
        ].join('\n');
        out(human, rep, asJson);
        return rep.ok ? 0 : 1;
      }

      case 'status': {
        const { config } = prepareConfig({ cwd, initData: false, dataDirOverride: args['data-dir'] });
        const runs = listRuns({ cwd, dataDirOverride: args['data-dir'] });
        const asr = checkWhisper('ffmpeg', resolveModel(cwd));
        const human = [
          `词表目录：${config.dataDir}（${config.dataOk ? '齐全' : `缺 ${config.missingFiles.length} 个文件`}）`,
          ...config.missingFiles.map((m) => `  缺：${m.key} → ${m.path}`),
          `语音转写：${asr.ok ? asr.message : `不可用（${asr.message}）`}`,
          `历史运行：${runs.length} 次`,
          ...runs.slice(0, 10).map((r) => `  ${r.runId}  词条 ${r.keptCount}  ${r.ok ? '自检通过' : '自检未通过'}  ${r.docx}`),
        ].join('\n');
        out(human, { dataDir: config.dataDir, dataOk: config.dataOk, missing: config.missingFiles, asr, runs }, asJson);
        return 0;
      }

      case 'transcribe': {
        if (!positional.length) { out(USAGE, { error: 'missing-input' }, asJson); return 2; }
        const results = [];
        for (const p of positional) {
          const input = resolve(cwd, p);
          const r = transcribeSync({
            input,
            out: positional.length === 1 ? args.out : undefined,
            start: args.start != null ? Number(args.start) : undefined,
            duration: args.duration != null ? Number(args.duration) : undefined,
            language: args.language ? String(args.language) : 'en',
            gpu: !args['no-gpu'],
            model: args.model ? String(args.model) : undefined,
            // 默认不覆盖：已有字幕就报冲突，旧文件一个字节都不动
            overwrite: args.force === true,
          });
          results.push(r);
        }
        const human = [
          `转写完成（${results.length} 个文件）`,
          ...results.map((r) => `  ${r.out}\n    ${(r.bytes / 1024).toFixed(1)}KB，耗时 ${(r.elapsedMs / 1000).toFixed(0)}s（音频时长比见下）`),
          `  模型 ${results[0].model}`,
          `下一步：vocab-english digest <上面输出的 srt>`,
        ].join('\n');
        out(human, { results }, asJson);
        return 0;
      }

      case 'help':
      case undefined: {
        out(USAGE, { usage: USAGE }, asJson);
        return cmd === undefined ? 2 : 0;
      }

      default:
        out(`未知命令：${cmd}\n\n${USAGE}`, { error: 'unknown-command', cmd }, asJson);
        return 2;
    }
  } catch (e) {
    const payload = { error: e.code ?? 'ERROR', message: e.message, ...(e.missing ? { missing: e.missing } : {}) };
    if (asJson) out(null, payload, true);
    else process.stderr.write(`出错：${e.message}\n`);
    if (e.code === 'LEXICON_MISSING') return 3;
    if (e.code === 'INVALID_LANGUAGE') return 2;
    return 1;
  }
}
