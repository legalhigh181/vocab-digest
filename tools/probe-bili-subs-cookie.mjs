// 验证「匿名 + buvid3 cookie 能不能拿到字幕轨」。
// 思路：B 站有些接口在完全没有 cookie 时会返回空字幕轨；先像浏览器一样拿 buvid3/buvid4，
// 再问同一条视频的字幕列表，看是否出现轨。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const BV = process.argv[2] ?? 'BV1GJ411x7h7';

async function j(url, cookie = '') {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', ...(cookie ? { cookie } : {}) },
    signal: AbortSignal.timeout(15000),
  });
  return res.json();
}

const spi = await j('https://api.bilibili.com/x/frontend/finger/spi');
const b3 = spi?.data?.b_3;
const b4 = spi?.data?.b_4;
console.log('spi:', JSON.stringify(spi).slice(0, 160));

const view = await j(`https://api.bilibili.com/x/web-interface/view?bvid=${BV}`, `buvid3=${b3}; buvid4=${b4}`);
const cid = view?.data?.cid;
const aid = view?.data?.aid;
console.log(`${BV} cid=${cid} aid=${aid} title=${view?.data?.title}`);

for (const [label, cookie] of [['无 cookie', ''], ['带 buvid3/4', `buvid3=${b3}; buvid4=${b4}`]]) {
  const r = await j(`https://api.bilibili.com/x/player/v2?bvid=${BV}&cid=${cid}`, cookie);
  const subs = r?.data?.subtitle?.subtitles ?? [];
  console.log(`${label}: code=${r.code} 字幕轨=${subs.length} ${subs.map((s) => s.lan).join(',')}`);
  const r2 = await j(`https://api.bilibili.com/x/player/wbi/v2?bvid=${BV}&cid=${cid}`, cookie);
  const subs2 = r2?.data?.subtitle?.subtitles ?? [];
  console.log(`${label} (wbi/v2): code=${r2.code} 字幕轨=${subs2.length} ${subs2.map((s) => s.lan).join(',')}`);
}
