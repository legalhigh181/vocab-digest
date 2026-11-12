// 扫一轮 B 站排行榜视频，看哪些真的有字幕轨（正向对照用）。
// 目的：证明「x/player/v2 匿名能返回字幕轨」这件事，从而让「某条视频没有字幕轨」的结论可信。
// 只读，不下载任何东西。
import { subtitleList } from '../src/bili.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
    signal: AbortSignal.timeout(15000),
  });
  return res.json();
}

const limit = Number(process.argv[2] ?? 30);
const rank = await getJson('https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all');
if (rank.code !== 0) {
  console.error('排行榜接口失败：', rank.code, rank.message);
  process.exit(1);
}
const list = (rank.data?.list ?? []).slice(0, limit);
console.log(`排行榜取到 ${list.length} 条，逐条查字幕轨…`);

let withSubs = 0;
const found = [];
for (const v of list) {
  const cid = v.cid ?? v.pages?.[0]?.cid;
  if (!cid) continue;
  let r;
  try {
    r = await subtitleList({ bvid: v.bvid, cid });
  } catch (e) {
    console.log(`  ${v.bvid} 查询异常：${e.message}`);
    continue;
  }
  if (!r.ok) {
    console.log(`  ${v.bvid} 接口失败：${r.error}`);
    continue;
  }
  if (r.subtitles.length) {
    withSubs += 1;
    found.push({ bvid: v.bvid, title: v.title, subs: r.subtitles.map((s) => `${s.lan}${s.ai ? '(AI)' : ''}`) });
    console.log(`  有字幕 ${v.bvid} 《${v.title}》 ${r.subtitles.map((s) => s.lan + (s.ai ? '(AI)' : '')).join(', ')}`);
  }
  await new Promise((r2) => setTimeout(r2, 120));
}

console.log(`\n合计：${list.length} 条里 ${withSubs} 条带字幕轨`);
if (found.length) {
  console.log('正向对照样本：');
  for (const f of found.slice(0, 5)) console.log(`  ${f.bvid} ${f.subs.join(',')} 《${f.title}》`);
} else {
  console.log('这一轮没扫到带字幕轨的视频 —— 无法作为正向对照。');
}
