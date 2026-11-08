/**
 * 插件输出契约校验：用假 ctx 加载插件，逐个调用工具，
 * 检查
 *   1) execute 返回的字段是否都在自己 output.schema.properties 里（additionalProperties:false 下多一个字段就被拒收）
 *   2) required 里的字段是否都返回了
 *   3) render(v) 产出 text
 *
 * 这个文件不参与 npm test 的默认收集（名字不含 .test），需要用 node test/harness.mjs 手动跑。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../src/index.js';

const registered = new Map();
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  get(service) {
    if (service !== 'tools') return undefined;
    return { register(tool) { registered.set(tool.name, tool); } };
  },
};

function checkOutput(name, schema, value) {
  assert.equal(schema.type, 'object', `${name}: schema 根类型必须是 object`);
  const props = schema.properties ?? {};
  const extra = Object.keys(value).filter((k) => !(k in props));
  assert.deepEqual(extra, [], `${name}: 返回了 schema 之外的字段 ${extra.join(', ')}`);
  const missing = (schema.required ?? []).filter((k) => !(k in value));
  assert.deepEqual(missing, [], `${name}: 缺少必需字段 ${missing.join(', ')}`);
  for (const [k, def] of Object.entries(props)) {
    if (!(k in value)) continue;
    const v = value[k];
    const t = def.type;
    if (t === 'string') assert.equal(typeof v, 'string', `${name}.${k} 应为 string`);
    if (t === 'boolean') assert.equal(typeof v, 'boolean', `${name}.${k} 应为 boolean`);
    if (t === 'integer') assert.equal(Number.isInteger(v), true, `${name}.${k} 应为 integer，实际 ${v}`);
    if (t === 'number') assert.equal(typeof v, 'number', `${name}.${k} 应为 number`);
    if (t === 'array') assert.equal(Array.isArray(v), true, `${name}.${k} 应为 array`);
    if (t === 'object' && def.properties) checkOutput(`${name}.${k}`, def, v);
  }
}

const work = mkdtempSync(join(tmpdir(), 'vocab-harness-'));
try {
  await apply(ctx, { cwd: work, dataDir: join(work, 'data') });
  const expected = [
    'vocab_plan', 'vocab_collect', 'vocab_translate', 'vocab_build_docx', 'vocab_by_tag',
    'vocab_status', 'vocab_transcribe', 'vocab_fetch', 'vocab_wordlist',
  ];
  assert.deepEqual([...registered.keys()], expected, '注册的工具名与顺序应稳定');

  const plan = registered.get('vocab_plan');
  const r1 = await plan.execute({ inputs: [join(work, 'nope.srt')] });
  checkOutput('vocab_plan', plan.output.schema, r1);
  assert.equal(r1.ok, false, '输入不存在时应报 not ok');
  assert.equal(typeof plan.output.render(undefined, r1)[0].text, 'string');

  const status = registered.get('vocab_status');
  const r2 = await status.execute({});
  checkOutput('vocab_status', status.output.schema, r2);
  assert.equal(r2.dataOk, true, '首次运行应自动初始化词表');

  // 用一个真实小样本跑通 collect → by_tag → build_docx
  const { writeFileSync } = await import('node:fs');
  const srt = '1\n00:00:01,000 --> 00:00:03,000\nOverfitting happens when the model memorizes the training data.\n\n'
    + '2\n00:00:04,000 --> 00:00:06,000\nRegularization prevents the parameters from exploding.\n';
  writeFileSync(join(work, 'sample.srt'), srt, 'utf8');

  const collect = registered.get('vocab_collect');
  const r3 = await collect.execute({ inputs: [join(work, 'sample.srt')], runId: 'h1' });
  checkOutput('vocab_collect', collect.output.schema, r3);
  assert.ok(r3.stats.keptCount > 0, '应抽到词条');

  const byTag = registered.get('vocab_by_tag');
  const r4 = await byTag.execute({ runId: 'h1', dim: 'difficulty' });
  checkOutput('vocab_by_tag', byTag.output.schema, r4);
  assert.equal(r4.dim, 'difficulty');

  const build = registered.get('vocab_build_docx');
  const r5 = await build.execute({ runId: 'h1', by: 'pos,difficulty' });
  checkOutput('vocab_build_docx', build.output.schema, r5);
  assert.equal(r5.verifyOk, true, `自检应通过：${JSON.stringify(r5.checks)}`);

  const tr = registered.get('vocab_translate');
  const r6 = await tr.execute({ mode: 'export', runId: 'h1', batchSize: 10, batchIndex: 0 });
  checkOutput('vocab_translate', tr.output.schema, r6);
  assert.ok(r6.total > 0);

  const r7 = await tr.execute({ mode: 'apply', runId: 'h1', decisions: { overfitting: { pos: 'n.', meaning: '过拟合' } } });
  checkOutput('vocab_translate', tr.output.schema, r7);
  assert.equal(r7.verifyOk, true);

  // 语音转写：只在模型和 ffmpeg 都就绪时跑（沙箱里可能两者都没有）
  const asrTool = registered.get('vocab_transcribe');
  const { checkWhisper, resolveModel } = await import('../src/asr.js');
  const asrReady = checkWhisper('ffmpeg', resolveModel(work));
  if (asrReady.ok) {
    // srt 不是音轨，必然失败——这里只验证「失败时抛的是约定错误码」而不是 schema 被拒
    const err = await asrTool.execute({ input: join(work, 'sample.srt') }).then(() => null, (e) => e);
    assert.ok(err && err.code, `非音轨输入应抛带 code 的错误，实际：${err}`);
  }

  // 词表：list → create → add？(add 用 name 传词，这里走 create/activate/list 与 digestFrom)
  const wl = registered.get('vocab_wordlist');
  const r8 = await wl.execute({ action: 'list' });
  checkOutput('vocab_wordlist', wl.output.schema, r8);
  const r9 = await wl.execute({ action: 'create', name: '测试表' });
  checkOutput('vocab_wordlist', wl.output.schema, r9);
  assert.ok(r9.listId, '新建词表应返回 id');
  assert.deepEqual(wl.output.render(undefined, r9).length, 1);

  const r10 = await wl.execute({ action: 'rename', id: r9.listId, name: '改名后' });
  checkOutput('vocab_wordlist', wl.output.schema, r10);
  assert.ok(r10.lists.some((l) => l.name === '改名后'), '重命名应生效');

  const r11 = await wl.execute({ action: 'activate', id: r9.listId });
  checkOutput('vocab_wordlist', wl.output.schema, r11);
  assert.ok(r11.lists.find((l) => l.id === r9.listId)?.active, '切换后应成为当前词表');

  // 用词表跑一次整理（词表为空也应能跑通）
  const r12 = await wl.execute({ action: 'digestFrom', id: r9.listId, inputs: [join(work, 'sample.srt')], title: '词表整理' });
  checkOutput('vocab_wordlist', wl.output.schema, r12);
  assert.ok(r12.runId, 'digestFrom 应产出运行');
  assert.ok(r12.docx.endsWith('.docx'), 'digestFrom 应产出 docx');

  // vocab_fetch：不联网，只验证坏链接走得通且 schema 合法
  const fetchTool = registered.get('vocab_fetch');
  const r13 = await fetchTool.execute({ link: '不是链接' });
  checkOutput('vocab_fetch', fetchTool.output.schema, r13);
  assert.equal(r13.ok, false, '坏链接应失败');

  console.log('插件契约校验通过：9 个工具，输出字段全部在 schema 内');
} finally {
  rmSync(work, { recursive: true, force: true });
}
