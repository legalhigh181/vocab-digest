/**
 * 导出：把一次 run 的结果导成「按标签查看」的纯文本清单。
 *
 * 为什么需要：Word 里按标签翻章只能靠跳转；给 LLM 翻译、或者自己速览时，
 * 一份按标签排好的 txt 更直接 —— 这是 m00186「按标签选择查看类型」的
 * 命令行/插件一侧的实现（Word 一侧是文档内的标签索引 + 多套标签章节）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { TAG_DIMENSIONS, TAG_DIM_LABELS, groupByTag, tagsOf } from './classify.js';
import { applyDecisions, localIso, readDecisions } from './run.js';
import { stablePretty } from './util.js';

/**
 * 按标签过滤词条。
 * @param {Array} items 词条
 * @param {object} filter { pos, difficulty, source, freq, tag }
 *  - tag: 'difficulty:basic' / 'pos:n.' / 'source:lecture.srt' 这种 "维度:值" 形式
 */
export function filterItems(items, filter = {}) {
  let out = items;
  const byTag = (dim, value) => {
    if (!value) return;
    out = out.filter((it) => {
      const t = tagsOf(it);
      const v = t[dim];
      return Array.isArray(v) ? v.includes(value) : v === value;
    });
  };
  if (filter.tag) {
    const [dim, ...rest] = String(filter.tag).split(':');
    if (TAG_DIMENSIONS.includes(dim)) byTag(dim, rest.join(':'));
  }
  byTag('pos', filter.pos);
  byTag('difficulty', filter.difficulty);
  byTag('source', filter.source);
  byTag('freq', filter.freq);
  return out;
}

/** 渲染成可读文本 */
export function renderTagView(digest, { dim = 'pos', filter = {}, showSamples = true } = {}) {
  const items = filterItems(digest.items ?? [], filter);
  const groups = groupByTag(items, dim);
  const lines = [
    `# 标签视图 · ${TAG_DIM_LABELS[dim] ?? dim}`,
    `# 运行 ${digest.runId ?? '-'} · 共 ${items.length} 个词条` + (Object.keys(filter).length ? ` · 过滤 ${JSON.stringify(filter)}` : ''),
    '',
  ];
  for (const g of groups) {
    lines.push(`## ${g.label}`);
    for (const it of g.items) {
      const meaning = it.meaning ? `  —— ${it.meaning}` : '';
      lines.push(`- ${it.display || it.word} [${it.posLabel ?? it.pos}] ×${it.count}${meaning}`);
      if (showSamples) {
        for (const s of (it.samples ?? []).slice(0, 1)) lines.push(`    > ${s.text}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** 把标签视图落盘成 <模板名>-by-<dim>.txt，返回文件路径 */
export function exportTagView(runDir, digest, opts = {}) {
  const dim = opts.dim ?? 'pos';
  const text = renderTagView(digest, opts);
  const file = join(resolve(runDir), `${opts.prefix ?? 'vocab'}-by-${dim}.txt`);
  writeFileSync(file, text, 'utf8');
  return { file, chars: text.length, items: filterItems(digest.items ?? [], opts.filter ?? {}).length };
}

/**
 * 导出待翻译批次（给 LLM / 人工）。
 * @param {object} digest 结果
 * @param {object} opts { batchSize }
 */
export function batchesOf(digest, opts = {}) {
  const batchSize = Number(opts.batchSize ?? 40);
  const decisions = opts.decisions ?? {};
  const todo = (digest.items ?? []).filter((it) => !decisions[it.word]?.meaning);
  const batches = [];
  for (let i = 0; i < todo.length; i += batchSize) {
    batches.push(todo.slice(i, i + batchSize).map((it) => ({
      word: it.word,
      pos: it.pos,
      count: it.count,
      sample: it.samples?.[0]?.text ?? '',
    })));
  }
  return { total: todo.length, batchSize, batches };
}

/** 读一个 run 目录里的 digest（含 decisions 叠加） */
export function loadRunDigest(runDir) {
  const dir = resolve(runDir);
  const file = join(dir, 'digest.json');
  if (!existsSync(file)) {
    const err = new Error(`不是有效的运行目录（缺 digest.json）：${dir}`);
    err.code = 'RUN_INVALID';
    throw err;
  }
  const dig = JSON.parse(readFileSync(file, 'utf8'));
  const decisionsFile = join(dir, 'decisions.json');
  const decisions = existsSync(decisionsFile) ? readDecisions(decisionsFile) : {};
  return applyDecisions(dig, decisions);
}

/** 写待翻译批次文件 */
export function writeTranslateBatches(runDir, digest, opts = {}) {
  const { total, batchSize, batches } = batchesOf(digest, opts);
  const file = join(resolve(runDir), `translate-batch-${opts.stamp ?? Date.now()}.json`);
  writeFileSync(file, stablePretty({ generatedAt: localIso(), runDir: resolve(runDir), total, batchSize, batches }), 'utf8');
  return { file, total, batchSize, batchCount: batches.length, batches };
}
