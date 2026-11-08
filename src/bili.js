// B 站视频取字幕 / 弹幕 / 音频 —— 只用 node 内置 fetch，不依赖第三方库。
// 用法见 src/pipeline.js 的 fetchVideo() 与 CLI 的 `vocab-english fetch`。

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com/';

/** 从各种 B 站链接 / 裸 BV 号里解析 bvid、aid、分 P */
export function parseBvid(input) {
  const s = String(input ?? '').trim();
  if (!s) return { ok: false, error: '空链接' };
  const bv = s.match(/BV[0-9A-Za-z]{10}/);
  const av = s.match(/(?:^|\/|av)(?:av)?(\d{5,})/i);
  const p = s.match(/[?&]p=(\d+)/);
  const t = s.match(/[?&]t=(\d+)/);
  if (bv) return { ok: true, bvid: bv[0], page: p ? Number(p[1]) : 1, t: t ? Number(t[1]) : 0 };
  if (av) return { ok: true, aid: Number(av[1]), page: p ? Number(p[1]) : 1, t: t ? Number(t[1]) : 0 };
  return { ok: false, error: '链接里没找到 BV 号或 av 号' };
}

async function getJson(url, { timeoutMs = 20000, headers = {} } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, referer: REFERER, ...headers },
      signal: ctl.signal,
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, json: await res.json() };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? '请求超时' : String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

/** 视频基本信息 + 分 P 列表 */
export async function videoInfo(ref) {
  const q = ref.bvid ? `bvid=${ref.bvid}` : `aid=${ref.aid}`;
  const r = await getJson(`https://api.bilibili.com/x/web-interface/view?${q}`);
  if (!r.ok) return { ok: false, error: r.error };
  const j = r.json;
  if (j.code !== 0) return { ok: false, error: `接口返回 code=${j.code} ${j.message || ''}`.trim() };
  const d = j.data;
  return {
    ok: true,
    info: {
      bvid: d.bvid,
      aid: d.aid,
      title: d.title,
      owner: d.owner?.name ?? '',
      duration: d.duration,
      desc: (d.desc ?? '').slice(0, 200),
      pages: (d.pages ?? []).map((p) => ({ page: p.page, cid: p.cid, title: p.part, duration: p.duration })),
    },
  };
}

/** 字幕列表（AI 字幕 + 人工字幕）。多数视频没有字幕轨，返回空数组是正常情况。 */
export async function subtitleList({ bvid, aid, cid }) {
  const q = bvid ? `bvid=${bvid}&cid=${cid}` : `aid=${aid}&cid=${cid}`;
  const r = await getJson(`https://api.bilibili.com/x/player/v2?${q}`);
  if (!r.ok) return { ok: false, error: r.error, subtitles: [] };
  if (r.json.code !== 0) return { ok: false, error: `code=${r.json.code}`, subtitles: [] };
  const list = r.json.data?.subtitle?.subtitles ?? [];
  return {
    ok: true,
    subtitles: list.map((s) => ({
      lan: s.lan,
      lanDoc: s.lan_doc,
      url: s.subtitle_url,
      ai: s.ai_type != null && s.ai_type !== 0,
    })),
  };
}

/** 下载一条字幕，转成统一样式 `[{from,to,content}]` */
export async function subtitleBody(url) {
  const u = url.startsWith('//') ? `https:${url}` : url;
  const r = await getJson(u);
  if (!r.ok) return { ok: false, error: r.error };
  const body = r.json.body ?? [];
  return {
    ok: true,
    lines: body.map((b) => ({ from: Number(b.from ?? 0), to: Number(b.to ?? 0), content: String(b.content ?? '') })),
  };
}

/** 弹幕索引：/x/v2/dm/web/view 返回 protobuf（DmSegConfig），不是 json，故退化为按固定段长估算 */
async function danmakuIndex({ cid, duration = 0 }) {
  const seg = 6; // 秒/片
  const total = duration > 0 ? Math.max(1, Math.ceil(duration / seg)) : 1;
  return { ok: true, data: { dm_seg: { segment_size: seg, total } } };
}

/** 弹幕：protobuf 分片逐个下载并按时间顺序拼成统一条目 */
export async function danmaku({ cid, page = 1, duration = 0 }) {
  const idx = await danmakuIndex({ cid, duration });
  const seg = idx.data.dm_seg.segment_size;
  const total = idx.data.dm_seg.total;
  const tasks = [];
  for (let i = 1; i <= total; i += 1) tasks.push(fetchSeg({ cid, page, i }));
  const lists = await Promise.all(tasks);
  const parts = lists.flat();
  parts.sort((a, b) => a.t - b.t);
  return { ok: true, count: parts.length, segmentSize: seg, items: parts };
}

async function fetchSeg({ cid, page, i }) {
  const u = `https://api.bilibili.com/x/v2/dm/web/seg.so?type=1&oid=${cid}&pid=${cid}&segment_index=${i}&p=${page}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(u, { headers: { 'user-agent': UA, referer: REFERER }, signal: ctl.signal });
    if (!res.ok) return [];
    const buf = Buffer.from(await res.arrayBuffer());
    return decodeSeg(buf);
  } catch {
    return []; // 单个分片失败不影响整体
  } finally {
    clearTimeout(timer);
  }
}

/** 简易 protobuf 解码：只取 DmSegMobileReply 里每个 Elems 的 progress/mode/content */
function decodeSeg(buf) {
  const out = [];
  let i = 0;
  const readVarint = () => {
    let shift = 0;
    let val = 0;
    while (i < buf.length) {
      const b = buf[i++];
      val += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) break;
      shift += 7;
    }
    return val;
  };
  while (i < buf.length) {
    const tag = readVarint();
    const field = tag >> 3;
    const wire = tag & 7;
    if (wire === 2) {
      const len = readVarint();
      const start = i;
      const end = Math.min(buf.length, start + len);
      if (field === 1) out.push(decodeElem(buf.subarray(start, end)));
      i = end;
    } else if (wire === 0) {
      readVarint();
    } else if (wire === 1) {
      i += 8;
    } else if (wire === 5) {
      i += 4;
    } else {
      break;
    }
  }
  return out.filter(Boolean);
}

function decodeElem(b) {
  let i = 0;
  const readVarint = () => {
    let shift = 0;
    let val = 0;
    while (i < b.length) {
      const x = b[i++];
      val += (x & 0x7f) * 2 ** shift;
      if (!(x & 0x80)) break;
      shift += 7;
    }
    return val;
  };
  let progress = 0;
  let mode = 1;
  let content = '';
  while (i < b.length) {
    const tag = readVarint();
    const field = tag >> 3;
    const wire = tag & 7;
    if (wire === 0) {
      const v = readVarint();
      if (field === 2) progress = v;
      else if (field === 3) mode = v;
    } else if (wire === 2) {
      const len = readVarint();
      const end = Math.min(b.length, i + len);
      if (field === 7) content = b.subarray(i, end).toString('utf8');
      i = end;
    } else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else break;
  }
  if (!content) return null;
  return { t: Math.round(progress / 1000), mode, content };
}

/** 播放地址里挑一条音频（音质最好的） */
export async function audioUrl({ bvid, aid, cid }) {
  const q = bvid ? `bvid=${bvid}&cid=${cid}` : `avid=${aid}&cid=${cid}`;
  const r = await getJson(`https://api.bilibili.com/x/player/playurl?${q}&fnval=16&fourk=1`);
  if (!r.ok) return { ok: false, error: r.error };
  if (r.json.code !== 0) return { ok: false, error: `code=${r.json.code}` };
  const dash = r.json.data?.dash;
  const audios = dash?.audio ?? [];
  if (!audios.length) return { ok: false, error: '没有音频流（可能是番剧/付费内容）' };
  const best = audios.slice().sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0];
  return { ok: true, url: best.baseUrl || best.base_url, bandwidth: best.bandwidth, mime: best.mimeType };
}

/** 下载二进制到文件（node fetch 流式写盘；CDN 直连失败时自动改走 bilivideo 镜像） */
export async function download(url, outPath, { onProgress, timeoutMs = 180000 } = {}) {
  const { writeFileSync } = await import('node:fs');
  const candidates = [url];
  const mirror = mirrorOf(url);
  if (mirror) candidates.push(mirror);
  let lastError = '';
  for (const u of candidates) {
    const r = await downloadOnce(u, { onProgress, timeoutMs });
    if (r.ok) {
      writeFileSync(outPath, r.buf);
      return { ok: true, bytes: r.buf.length, url: u };
    }
    lastError = r.error;
  }
  return { ok: false, error: lastError };
}

const MIRROR_HOST = 'upos-sz-mirrorcos.bilivideo.com';

function mirrorOf(url) {
  try {
    const u = new URL(url);
    if (!/bilivideo\.com$/.test(u.hostname)) return '';
    u.hostname = MIRROR_HOST;
    return u.toString();
  } catch {
    return '';
  }
}

async function downloadOnce(url, { onProgress, timeoutMs }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, referer: REFERER }, signal: ctl.signal });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const total = Number(res.headers.get('content-length') ?? 0);
    const chunks = [];
    let got = 0;
    for await (const chunk of res.body) {
      chunks.push(chunk);
      got += chunk.length;
      onProgress?.(got, total);
    }
    return { ok: true, buf: Buffer.concat(chunks) };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? '下载超时' : String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}
