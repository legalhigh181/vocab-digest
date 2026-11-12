// 正向对照：用搜索接口找「带字幕」的候选视频，再逐条问字幕轨。
// 目的是拿到至少一条「确定有字幕轨」的样本，证明匿名查字幕接口是可信的。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const KEYWORD = process.argv[2] ?? '日语字幕';

async function j(url, cookie = '') {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', ...(cookie ? { cookie } : {}) },
    signal: AbortSignal.timeout(15000),
  });
  return res.json();
}

const spi = await j('https://api.bilibili.com/x/frontend/finger/spi');
const cookie = `buvid3=${spi.data.b_3}; buvid4=${spi.data.b_4}`;

const s = await j(
  `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(KEYWORD)}&page=1`,
  cookie,
);
console.log('搜索 code=', s.code, '结果数=', s?.data?.result?.length ?? 0);
if (s.code !== 0) {
  console.log(JSON.stringify(s).slice(0, 300));
  process.exit(0);
}
const list = (s.data.result ?? []).slice(0, 12);
let hit = 0;
for (const v of list) {
  const bvid = v.bvid;
  const view = await j(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, cookie);
  const cid = view?.data?.cid;
  if (!cid) continue;
  const p = await j(`https://api.bilibili.com/x/player/v2?bvid=${bvid}&cid=${cid}`, cookie);
  const subs = p?.data?.subtitle?.subtitles ?? [];
  console.log(`${bvid} 轨=${subs.length} ${subs.map((x) => x.lan).join(',')} 《${String(v.title).replace(/<[^>]+>/g, '')}》`);
  if (subs.length) hit += 1;
  await new Promise((r) => setTimeout(r, 150));
}
console.log(`\n命中 ${hit} 条带字幕轨`);
