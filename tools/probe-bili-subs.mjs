/**
 * 找候选视频的字幕轨（真实 B 站验收用）。只读，不下载。
 * 用法：node tools/probe-bili-subs.mjs BV1GJ411x7h7 BV1H64y1e7YJ ...
 */
import { parseBvid, videoInfo, subtitleList } from '../src/bili.js';

const list = process.argv.slice(2);
if (!list.length) {
  console.error('用法：node tools/probe-bili-subs.mjs <BV号...>');
  process.exit(2);
}

for (const input of list) {
  const ref = parseBvid(input);
  if (!ref.ok) { console.log(`${input}: 解析失败 ${ref.error}`); continue; }
  const info = await videoInfo(ref);
  if (!info.ok) { console.log(`${input}: 取信息失败 ${info.error}`); continue; }
  const pages = info.info.pages ?? [];
  const page = pages.find((p) => p.page === (ref.page ?? 1)) ?? pages[0];
  const sub = await subtitleList({ bvid: info.info.bvid, cid: page.cid });
  const tracks = (sub.ok ? sub.subtitles : []).map((s) => `${s.lan}/${s.lanDoc}${s.ai ? '(AI)' : ''}`);
  console.log(`${info.info.bvid} p${page.page} 《${info.info.title}》 ${page.duration}s 字幕=${tracks.length ? tracks.join(' ') : (sub.ok ? '无' : '查询失败:' + sub.error)}`);
}
