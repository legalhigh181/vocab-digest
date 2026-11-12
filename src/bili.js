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
      // 字段名随接口版本变过：subtitle_url / url / subtitle_url_v2 都见过
      url: s.subtitle_url ?? s.url ?? s.subtitle_url_v2 ?? '',
      ai: s.ai_type != null && s.ai_type !== 0,
    })).filter((s) => s.url),
  };
}

/** 下载一条字幕，转成统一样式 `[{from,to,content}]` */
export async function subtitleBody(url) {
  if (!url) return { ok: false, error: '字幕地址为空', lines: [] };
  const u = url.startsWith('//') ? `https:${url}` : url;
  const r = await getJson(u);
  if (!r.ok) return { ok: false, error: r.error, lines: [] };
  const body = r.json?.body ?? [];
  return {
    ok: true,
    lines: body.map((b) => ({ from: Number(b.from ?? 0), to: Number(b.to ?? 0), content: String(b.content ?? '') })),
  };
}

/**
 * 弹幕索引（真实分片元数据）。
 *
 * `/x/v2/dm/web/view` 返回 DmView 的 protobuf。实测（2026-11，BV1Z7xh6HEfD / cid=43252712788）的结构是：
 *
 *   DmView {
 *     ...
 *     DmSegConfig dm_seg = 4;          ← 弹幕分片配置，就在 **field 4**，不是 1 或 2
 *   }
 *   DmSegConfig { int64 page_size = 1; int64 total = 2; }
 *
 * 这条视频解出来是 `page_size=360000 total=100`（毫秒时长 × 100 片）。
 *
 * 早期版本：① 图省事按时长估算片数（估错就丢弹幕或请求空片）；② 或把 field 1/2 当索引字段，
 * 两个都没有，最后报「page_size=0 total=0」。现在老老实实解 field 4。
 *
 * @returns {{ok:true, pageSize:number, total:number, durationMs:number} | {ok:false, error:string}}
 */
export async function danmakuIndex({ cid, aid, bvid } = {}) {
  const oid = cid ?? '';
  const u =
    'https://api.bilibili.com/x/v2/dm/web/view'
    + `?type=1&oid=${encodeURIComponent(oid)}`
    + (aid ? `&pid=${encodeURIComponent(aid)}` : '')
    + (bvid ? `&bvid=${encodeURIComponent(bvid)}` : '');

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(u, { headers: { 'user-agent': UA, referer: REFERER }, signal: ctl.signal });
    if (!res.ok) return { ok: false, error: `索引接口 HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return { ok: false, error: '索引接口返回空响应' };

    // 有时网关会吐 JSON 错误体（code != 0），这种要原样报出来而不是当成 0 片
    if (buf[0] === 0x7b) {
      try {
        const j = JSON.parse(buf.toString('utf8'));
        return { ok: false, error: `索引接口 code=${j.code ?? '?'} ${j.message ?? ''}`.trim() };
      } catch {
        return { ok: false, error: '索引接口返回无法解析的 JSON' };
      }
    }

    return decodeDmSegConfig(buf);
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? '索引请求超时' : String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 从 DmView 里取 DmSegConfig。
 * 兼容两种形态：整个响应就是索引（字段 1/2），或者索引嵌在 field 4（真实情况）。
 * 顺带解出 duration_ms（field 3），方便诊断。
 */
export function decodeDmSegConfig(buf) {
  let i = 0;
  let topLevelPageSize = 0;
  let topLevelTotal = 0;
  let durationMs = 0;
  let nested = null;

  while (i < buf.length) {
    let tag;
    [tag, i] = readVarintAt(buf, i);
    const field = tag >> 3;
    const wire = tag & 7;
    if (wire === 0) {
      let v;
      [v, i] = readVarintAt(buf, i);
      if (field === 1) topLevelPageSize = v;
      else if (field === 2) topLevelTotal = v;
      else if (field === 3) durationMs = v;
    } else if (wire === 2) {
      let len;
      [len, i] = readVarintAt(buf, i);
      const sub = buf.subarray(i, i + len);
      i += len;
      if (field === 4) nested = sub;
    } else if (wire === 1) {
      i += 8;
    } else if (wire === 5) {
      i += 4;
    } else {
      return { ok: false, error: `索引里有未知 wire type=${wire}（字段 ${field}）` };
    }
  }

  if (nested) {
    const inner = readPageSizeTotal(nested);
    if (inner.pageSize && inner.total) {
      return { ok: true, pageSize: inner.pageSize, total: inner.total, durationMs: durationMs || inner.durationMs };
    }
    return {
      ok: false,
      error: `索引内容不完整（page_size=${inner.pageSize} total=${inner.total}）`,
    };
  }
  if (topLevelPageSize && topLevelTotal) {
    return { ok: true, pageSize: topLevelPageSize, total: topLevelTotal, durationMs };
  }
  return { ok: false, error: `索引内容不完整（page_size=${topLevelPageSize} total=${topLevelTotal}）` };
}

function readVarintAt(buf, i) {
  let shift = 0;
  let val = 0;
  while (i < buf.length) {
    const b = buf[i++];
    val += (b & 0x7f) * 2 ** shift;
    if (!(b & 0x80)) return [val, i];
    shift += 7;
  }
  return [val, i];
}

function readPageSizeTotal(b) {
  let i = 0;
  let pageSize = 0;
  let total = 0;
  let durationMs = 0;
  while (i < b.length) {
    let tag;
    [tag, i] = readVarintAt(b, i);
    const field = tag >> 3;
    const wire = tag & 7;
    if (wire === 0) {
      let v;
      [v, i] = readVarintAt(b, i);
      if (field === 1) pageSize = v;
      else if (field === 2) total = v;
      else if (field === 3) durationMs = v;
    } else if (wire === 2) {
      let len;
      [len, i] = readVarintAt(b, i);
      i += len;
    } else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else break;
  }
  return { pageSize, total, durationMs };
}

/** 把任务分批并发执行，返回与输入同序的结果；maxParallel 是硬上限 */
export async function mapLimit(items, limit, worker) {
  const out = [];
  let cursor = 0;
  const n = Math.max(1, Math.floor(Number(limit) || 1));
  const runners = Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const idx = cursor++;
      if (idx >= items.length) return;
      out[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return out;
}

/** 默认并发上限：B 站对同一视频的分片接口比较敏感，开太多会被限流 */
export const DEFAULT_DANMAKU_CONCURRENCY = 4;

/**
 * 弹幕：按真实索引逐个下载分片，再按时间排序拼起来。
 *
 * 强调两点（都是踩过的坑）：
 *  - 分片失败**必须可见**：返回 failed 列表，由调用方决定是报错还是告警，
 *    绝不能让失败静默变成「0 条弹幕」。
 *  - 并发有上限：早期一次性 Promise.all(fetch 所有片)，几百片的视频会瞬间打满。
 *
 * @param {object} o { cid, aid, bvid, page, concurrency, maxSegments, fetchImpl }
 * @returns {{ok:true, count, segmentSize, total, fetched, failed, items}
 *          | {ok:false, error, stage:'index'|'segments'}}
 */
export async function danmaku(o = {}) {
  const { cid, aid, bvid, page = 1 } = o;
  const concurrency = Number(o.concurrency ?? DEFAULT_DANMAKU_CONCURRENCY);
  const fetchImpl = o.fetchImpl ?? fetchSeg;

  const idx = await danmakuIndex({ cid, aid, bvid });
  if (!idx.ok) return { ok: false, stage: 'index', error: idx.error };

  let total = idx.total;
  if (o.maxSegments != null) total = Math.min(total, Number(o.maxSegments));

  const tasks = Array.from({ length: total }, (_, i) => i + 1);
  const results = await mapLimit(tasks, concurrency, (i) => fetchImpl({ cid, page, i }));

  const items = [];
  const failed = [];
  results.forEach((r, i) => {
    if (r && r.ok) items.push(...r.items);
    else failed.push({ segment: i + 1, error: (r && r.error) || '未知错误' });
  });

  items.sort((a, b) => a.t - b.t);

  // 全部片都失败，且索引说有片 → 这是网络/接口问题，不能报成「0 条弹幕」
  if (total > 0 && failed.length === total) {
    return {
      ok: false,
      stage: 'segments',
      error: `全部 ${total} 个分片下载失败（${failed[0].error}）`,
      index: { pageSize: idx.pageSize, total: idx.total },
      failed,
    };
  }

  return {
    ok: true,
    count: items.length,
    segmentSize: idx.pageSize,
    total: idx.total,
    fetched: total - failed.length,
    failed,
    items,
  };
}

/** 下载单个分片 → {ok:true, items} | {ok:false, error} */
async function fetchSeg({ cid, page, i }) {
  const u = `https://api.bilibili.com/x/v2/dm/web/seg.so?type=1&oid=${cid}&pid=${cid}&segment_index=${i}&p=${page}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(u, { headers: { 'user-agent': UA, referer: REFERER }, signal: ctl.signal });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: true, items: decodeSeg(buf) };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? '分片超时' : String(e.message || e) };
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

/**
 * 下载二进制到文件。
 *
 * T6 重做（以前是「整个读进内存再 writeFileSync」）：
 *   - **流式写 .part**：边收边写，几百 MB 的音频不会撑爆内存；中途失败只留下 .part，
 *     不会出现「半个 mp4 顶着正式文件名」骗过后续流程。
 *   - **原子完成**：写完后 rename(.part → 目标)。同盘 rename 是原子的。
 *   - **有界重试**：指数退避，最多 retries 次；HTTP 4xx（除 408/429）直接放弃。
 *   - **节流**：重试之间等待 backoffMs 起步的间隔，避免把 CDN 打急。
 *   - **取消**：传 signal，立刻中断并清理 .part。
 *   - **镜像兜底**：CDN 直连失败再换 bilivideo 镜像，镜像也失败才算失败。
 *
 * @param {string} url
 * @param {string} outPath
 * @param {object} [o]
 * @param {(got:number,total:number)=>void} [o.onProgress]
 * @param {number} [o.timeoutMs]     单次请求的软超时（默认 180s）
 * @param {number} [o.retries]       每个候选地址的重试次数（默认 2，即最多试 3 次）
 * @param {number} [o.backoffMs]     首次退避间隔（默认 800ms，之后翻倍）
 * @param {boolean} [o.overwrite]    允许替换已存在的目标文件（默认不允许，冲突即失败）
 * @param {AbortSignal} [o.signal]   取消信号
 * @returns {Promise<{ok:true,bytes:number,url:string,attempts:number} | {ok:false,error:string,code:string}>}
 */
export async function download(url, outPath, o = {}) {
  const { createWriteStream, mkdirSync, renameSync, rmSync, existsSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  const { Readable } = await import('node:stream');
  const { pipeline } = await import('node:stream/promises');

  mkdirSync(dirname(outPath), { recursive: true });
  const partPath = `${outPath}.part`;
  const retries = Math.max(0, Number(o.retries ?? 2));
  const backoffMs = Math.max(0, Number(o.backoffMs ?? 800));

  const candidates = [url, ...mirrorOf(url)];

  // o.fetchImpl：测试注入入口。生产永远走全局 fetch。
  const fetchImpl = o.fetchImpl ?? fetch;

  let attempts = 0;
  let lastError = '';
  let lastCode = 'DOWNLOAD_FAILED';

  const cleanup = async () => {
    try {
      if (existsSync(partPath)) rmSync(partPath, { force: true });
    } catch {
      /* 清不掉就留着，下次启动会被覆盖 */
    }
  };

  for (const u of candidates) {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (o.signal?.aborted) {
        await cleanup();
        return { ok: false, code: 'CANCELLED', error: '下载被取消' };
      }
      attempts += 1;
      const ctl = new AbortController();
      const timer = o.timeoutMs > 0 ? setTimeout(() => ctl.abort(), o.timeoutMs) : null;
      const onAbort = () => ctl.abort();
      o.signal?.addEventListener?.('abort', onAbort, { once: true });
      try {
        const res = await fetchImpl(u, {
          headers: { 'user-agent': UA, referer: REFERER },
          signal: ctl.signal,
        });
        if (!res.ok) {
          lastError = `HTTP ${res.status}`;
          lastCode = `HTTP_${res.status}`;
          // 4xx 是地址/权限问题，重试没用（408/429 除外）
          const fatal = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
          await cleanup();
          if (fatal) return { ok: false, code: lastCode, error: lastError, attempts };
        } else {
          const total = Number(res.headers.get('content-length') ?? 0);
          let got = 0;
          const body = Readable.fromWeb(res.body);
          body.on('data', (chunk) => {
            got += chunk.length;
            o.onProgress?.(got, total);
          });
          await pipeline(body, createWriteStream(partPath));
          if (total > 0 && got !== total) {
            // 断流但没报错：长度对不上就是没下完，绝不能 rename 成正式文件
            lastError = `下载不完整（${got}/${total} 字节）`;
            lastCode = 'TRUNCATED';
            await cleanup();
          } else if (existsSync(outPath) && !o.overwrite) {
            // 提交前再查一次：`.part` 写完到提交之间，可能有人已经放了同名文件。
            // 不覆盖 → 明确报冲突，而不是把别人的文件换掉（"提交成功才替换"）。
            lastCode = 'OUTPUT_CONFLICT';
            lastError = `目标文件已存在：${outPath}`;
            await cleanup();
            return { ok: false, code: lastCode, error: lastError, attempts };
          } else {
            renameSync(partPath, outPath);
            return { ok: true, bytes: got, url: u, attempts };
          }
        }
      } catch (e) {
        lastError = e?.name === 'AbortError'
          ? (o.signal?.aborted ? '下载被取消' : '下载超时')
          : String(e?.message || e);
        lastCode = o.signal?.aborted ? 'CANCELLED' : (e?.name === 'AbortError' ? 'TIMEOUT' : 'DOWNLOAD_ERROR');
        await cleanup();
        if (o.signal?.aborted) return { ok: false, code: 'CANCELLED', error: '下载被取消', attempts };
      } finally {
        if (timer) clearTimeout(timer);
        o.signal?.removeEventListener?.('abort', onAbort);
      }
      if (attempt < retries) await sleep(backoffMs * 2 ** attempt, o.signal);
    }
  }
  return { ok: false, code: lastCode, error: lastError || '下载失败', attempts };
}

function sleep(ms, signal) {
  return new Promise((res) => {
    if (signal?.aborted) return res();
    const t = setTimeout(res, ms);
    signal?.addEventListener?.('abort', () => {
      clearTimeout(t);
      res();
    }, { once: true });
  });
}

// CDN 直连地址（cn-*.bilivideo.com）在某些网络里 TLS 握手直接失败，
// 所以失败后要挨个换镜像。单个镜像不够用：实测同一时刻 cos 镜像握手失败、
// ali 镜像正常（2026-11-11 真实验收遇到），所以这里是列表而不是常量。
const MIRROR_HOSTS = [
  'upos-sz-mirrorcos.bilivideo.com',
  'upos-sz-mirrorali.bilivideo.com',
];

/** 直连地址 → 各镜像地址（保留 path 与签名 query） */
function mirrorOf(url) {
  try {
    const u = new URL(url);
    if (!/bilivideo\.com$/.test(u.hostname)) return [];
    return MIRROR_HOSTS.map((host) => {
      const m = new URL(u.toString());
      m.hostname = host;
      return m.toString();
    });
  } catch {
    return [];
  }
}
