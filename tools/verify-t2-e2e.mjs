// 真实联网的端到端验证：fetch（withDanmaku）→ digest，确认真实路径能被 digest 吃进去。
// 只用来人工核对，不进单测。
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fetchVideo } from '../src/fetch.js';
import { runDigest } from '../src/run.js';

const link = process.argv[2] ?? 'BV1GJ411x7h7';
const cwd = process.cwd();

const r = await fetchVideo({
  link,
  cwd,
  page: 1,
  asr: false,          // 这条视频没有口播，跳过语音识别省时间
  withDanmaku: true,   // 只有弹幕的视频，必须开这个才交得出输入
  log: (m) => console.log('  ·', m),
});

console.log('fetch.ok =', r.ok, r.error ?? '');
if (!r.ok) process.exit(1);

console.log('inputs:', r.inputs);
console.log('全部存在:', r.inputs.every((p) => existsSync(p)));
console.log('playUrl:', r.playUrl);

const meta = runDigest({
  inputs: r.inputs,
  cwd,
  runId: `t2-live-${Date.now()}`,
  title: r.info.title,
  videoUrl: r.playUrl,
  videoTitle: r.info.title,
  videoPage: r.page,
  videoPages: r.totalPages,
});

console.log('\ndigest 结果:');
console.log('  runId      =', meta.runId);
console.log('  词条数     =', meta.stats?.keptCount ?? '?');
console.log('  来源数     =', meta.inputs?.length ?? '?');
console.log('  自检通过   =', meta.verify?.ok);
for (const p of meta.inputs ?? []) console.log('   —', p.name, p.kept ?? '');
