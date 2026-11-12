// 查 B 站视频的字幕轨语言（只看 x/player/v2 的 subtitle.subtitles，不下载媒体）。

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  Referer: 'https://www.bilibili.com/',
};

async function getJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  return res.json();
}

const BV = process.argv.slice(2);
for (const bvid of BV) {
  const view = await getJson(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
  if (view.code !== 0) { console.log(`${bvid}: view code=${view.code} ${view.message}`); continue; }
  const { aid, title, pages } = view.data;
  const cid = pages[0].cid;
  const player = await getJson(`https://api.bilibili.com/x/player/v2?aid=${aid}&cid=${cid}`);
  const subs = player?.data?.subtitle?.subtitles ?? [];
  console.log(`\n${bvid}  ${title.slice(0, 40)}  共 ${pages.length}P`);
  if (!subs.length) console.log('  无字幕轨');
  for (const s of subs) {
    console.log(`  lan=${s.lan}  lan_doc=${s.lan_doc}  ai=${s.ai_status ?? ''}  url=${String(s.subtitle_url || s.url || '').slice(0, 80)}`);
  }
}
