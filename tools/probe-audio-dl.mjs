/**
 * 诊断：音频下载 fetch failed 的真实原因（网络层）。
 * 用法：node tools/probe-audio-dl.mjs BV1GJ411x7h7
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { audioUrl, parseBvid, videoInfo, download } from '../src/bili.js';

const input = process.argv[2] ?? 'BV1GJ411x7h7';
const ref = parseBvid(input);
const info = await videoInfo(ref);
if (!info.ok) { console.log('视频信息失败', info.error); process.exit(1); }
const page = info.info.pages[0];
const au = await audioUrl({ bvid: info.info.bvid, aid: info.info.aid, cid: page.cid });
console.log('audioUrl ok=', au.ok, 'err=', au.error);
console.log('url host=', au.url ? new URL(au.url).host : '-');

// 1) 裸 fetch，看 cause
if (au.ok) {
  try {
    const r = await fetch(au.url, { headers: { referer: 'https://www.bilibili.com/' } });
    console.log('裸 fetch status=', r.status, 'len=', r.headers.get('content-length'));
  } catch (e) {
    console.log('裸 fetch 抛错:', e.message, '| cause:', e.cause?.code ?? e.cause?.message ?? e.cause);
  }
}

// 2) 真实 download()
const dir = mkdtempSync(join(tmpdir(), 'audio-dl-'));
try {
  const dl = await download(au.url, join(dir, 'audio.m4s'), { overwrite: true });
  console.log('download:', JSON.stringify({ ok: dl.ok, code: dl.code, error: dl.error, bytes: dl.bytes }));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
