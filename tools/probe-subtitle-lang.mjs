// 找带日文字幕轨的 B 站视频（只用公开接口，不下载媒体）。
import { spawnSync } from 'node:child_process';

const BV = process.argv.slice(2);
for (const bvid of BV) {
  const r = spawnSync(process.execPath, ['bin/vocab-english.js', 'fetch', bvid, '--no-asr', '--no-danmaku', '--json'], {
    encoding: 'utf8', env: process.env,
  });
  const text = (r.stdout || '').trim();
  let j = null;
  try { j = JSON.parse(text); } catch { /* ignore */ }
  const err = j ? '' : text.split('\n').slice(-2).join(' ');
  console.log(`${bvid}: ok=${j?.ok} subtitle=${j?.subtitle ?? '-'} ${j?.error ? 'err=' + String(j.error).slice(0, 90) : ''}${err}`);
}
