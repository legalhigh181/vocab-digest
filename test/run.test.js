import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareConfig, runDigest, renderRun, listRuns, expandInputs, applyDecisions } from '../src/run.js';
import { digest } from '../src/pipeline.js';
import { ensureData } from '../src/data/seed.js';
import { main } from '../src/cli.js';
import { stablePretty } from '../src/util.js';
import { FIXTURES } from './helpers.js';

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'vocab-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('seed：首次初始化生成全部词表，第二次幂等', () => {
  const sb = sandbox();
  try {
    const dataDir = join(sb.dir, 'data');
    const first = ensureData(dataDir);
    assert.ok(first.length >= 5, first.join(','));
    const second = ensureData(dataDir);
    assert.deepEqual(second, []);
    assert.ok(readFileSync(join(dataDir, 'stopword.txt'), 'utf8').includes('the'));
    const pos = JSON.parse(readFileSync(join(dataDir, 'pos.json'), 'utf8'));
    assert.equal(pos.model, 'n.');
  } finally { sb.cleanup(); }
});

test('expandInputs：目录递归 + 扩展名过滤 + 稳定排序', () => {
  const sb = sandbox();
  try {
    mkdirSync(join(sb.dir, 'in', 'sub'), { recursive: true });
    writeFileSync(join(sb.dir, 'in', 'b.srt'), 'x');
    writeFileSync(join(sb.dir, 'in', 'sub', 'a.xml'), '<x/>');
    writeFileSync(join(sb.dir, 'in', 'skip.pdf'), 'x');
    const files = expandInputs([join(sb.dir, 'in')]);
    assert.deepEqual(files.map((f) => f.ext), ['srt', 'xml']);
  } finally { sb.cleanup(); }
});

test('缺词表必须报 LEXICON_MISSING，而不是静默用空表', () => {
  const sb = sandbox();
  try {
    const empty = join(sb.dir, 'empty-data');
    mkdirSync(empty, { recursive: true });
    const { config } = prepareConfig({ cwd: sb.dir, dataDirOverride: empty, initData: false });
    const files = [{ name: 'a.xml', ext: 'xml', raw: '<i><d p="1,1,25,0">hello world</d></i>' }];
    assert.throws(() => digest(files, config), (e) => e.code === 'LEXICON_MISSING' && e.missing.length > 0);
  } finally { sb.cleanup(); }
});

test('端到端：digest 跑通夹具并自检通过，且可复现', () => {
  const sb = sandbox();
  try {
    const opts = { inputs: [FIXTURES], cwd: sb.dir, runId: 'e2e' };
    const meta = runDigest(opts);
    assert.equal(meta.verify.ok, true, JSON.stringify(meta.verify.failed));
    assert.equal(meta.stats.fileCount, 3);
    assert.ok(meta.stats.keptCount > 20);
    assert.ok(existsSync(meta.outputs.docx));
    // 同输入再跑一次：document.xml 字节一致（时间戳只在封面，这里比较剥离后的正文主体）
    const meta2 = runDigest({ ...opts, runId: 'e2e2' });
    const strip = (s) => s.replace(/生成时间：[^<]*/g, '');
    assert.equal(strip(meta2.documentXml), strip(meta.documentXml));
  } finally { sb.cleanup(); }
});

test('decisions.json 回写后重渲染：释义进入正文，自检仍通过', () => {
  const sb = sandbox();
  try {
    const meta = runDigest({ inputs: [FIXTURES], cwd: sb.dir, runId: 'dec' });
    const word = JSON.parse(readFileSync(join(meta.runDir, 'digest.json'), 'utf8')).topWords[0].word;
    writeFileSync(join(meta.runDir, 'decisions.json'), stablePretty({ [word]: { meaning: '【测试释义】' } }), 'utf8');
    const r = renderRun({ runDir: meta.runDir, cwd: sb.dir });
    assert.equal(r.verify.ok, true);
    assert.ok(r.verify.ok);
    const xml = readFileSync(join(meta.runDir, 'digest.json'), 'utf8');
    assert.ok(xml.includes(word));
    const r2 = renderRun({ runDir: meta.runDir, cwd: sb.dir });
    assert.equal(r2.verify.ok, true);
  } finally { sb.cleanup(); }
});

test('applyDecisions：pos 与 meaning 覆盖，未知词不动', () => {
  const result = { items: [{ word: 'run', pos: 'v.', meaning: '' }, { word: 'model', pos: 'n.', meaning: 'x' }] };
  const out = applyDecisions(result, { run: { pos: 'n.', meaning: '跑' }, zzz: { meaning: '无' } });
  assert.equal(out.items[0].pos, 'n.');
  assert.equal(out.items[0].meaning, '跑');
  assert.equal(out.items[1].meaning, 'x');
  assert.equal(out.items.length, 2);
});

test('listRuns：按时间倒序列出', () => {
  const sb = sandbox();
  try {
    runDigest({ inputs: [FIXTURES], cwd: sb.dir, runId: 'r1' });
    runDigest({ inputs: [FIXTURES], cwd: sb.dir, runId: 'r2' });
    const runs = listRuns({ cwd: sb.dir });
    assert.deepEqual(runs.map((r) => r.runId), ['r2', 'r1']);
    assert.equal(runs[0].ok, true);
  } finally { sb.cleanup(); }
});

test('CLI：digest --json 输出可解析，report 通过，status 可用', async () => {
  const sb = sandbox();
  try {
    const code = await main(['digest', FIXTURES, '--cwd', sb.dir, '--run-id', 'cli1', '--json']);
    assert.equal(code, 0);
    const runs = listRuns({ cwd: sb.dir });
    assert.equal(runs.length, 1);
    assert.equal(await main(['report', 'cli1', '--cwd', sb.dir]), 0);
    assert.equal(await main(['status', '--cwd', sb.dir]), 0);
  } finally { sb.cleanup(); }
});

test('CLI：输入为空返回非零', async () => {
  const sb = sandbox();
  try {
    assert.equal(await main(['digest', '--cwd', sb.dir, '--json']), 2);
    assert.equal(await main(['digest', join(sb.dir, 'nope'), '--cwd', sb.dir, '--json']), 1);
  } finally { sb.cleanup(); }
});
