// 真实联网验证（T2）。会真的请求 B 站接口，只用来人工核对，不放进单测。
//
// 用法：node tools/verify-t2-live.mjs [BV号]
// 输出 JSON，字段含义见 docs/fix-list.md 的「验证记录」。
// 代理要在外面设好：$env:HTTPS_PROXY="http://127.0.0.1:7897"
import { danmaku, danmakuIndex, parseBvid, videoInfo } from '../src/bili.js';
import { fetchVideo } from '../src/fetch.js';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const link = process.argv[2] ?? 'BV1Z7xh6HEfD';
const ref = parseBvid(link);
const out = { link, ref };

const info = await videoInfo(ref);
out.videoInfo = info.ok
  ? { bvid: info.info.bvid, title: info.info.title, totalPages: info.info.pages.length, pages: info.info.pages.map((p) => ({ page: p.page, cid: p.cid, title: p.title })) }
  : { error: info.error };

if (info.ok) {
  const cid = info.info.pages[0].cid;
  const idx = await danmakuIndex({ cid, bvid: info.info.bvid, aid: info.info.aid });
  out.index = idx;

  if (idx.ok) {
    const t0 = Date.now();
    const dm = await danmaku({ cid, bvid: info.info.bvid, aid: info.info.aid, page: 1, concurrency: 4 });
    out.danmaku = {
      ok: dm.ok,
      error: dm.error,
      count: dm.count,
      totalSegments: dm.total,
      fetchedSegments: dm.fetched,
      failedCount: (dm.failed ?? []).length,
      elapsedMs: Date.now() - t0,
      sample: (dm.items ?? []).slice(0, 3).map((d) => ({ t: d.t, content: d.content })),
    };
  }

  const cwd = mkdtempSync(join(tmpdir(), 'vd-t2-live-'));
  const r = await fetchVideo({ link, cwd, page: 1, asr: false, withDanmaku: false, log: () => {} });
  out.fetchVideo = {
    ok: r.ok,
    error: r.error,
    page: r.page,
    cid: r.cid,
    playUrl: r.playUrl,
    subtitle: r.subtitle,
    danmaku: r.danmaku,
    danmakuOk: r.danmakuInfo?.ok,
    danmakuError: r.danmakuInfo?.error,
    inputsAllExist: (r.inputs ?? []).map((p) => existsSync(p)),
    inputs: (r.inputs ?? []).map((p) => p.replace(cwd, '<cwd>')),
  };
  if (r.metaFile && existsSync(r.metaFile)) {
    out.meta = JSON.parse(readFileSync(r.metaFile, 'utf8'));
    out.meta.playUrl = out.meta.playUrl;
  }
}

console.log(JSON.stringify(out, null, 2));
