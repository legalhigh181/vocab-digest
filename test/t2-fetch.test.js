// T2 测试：弹幕开关、多 P 路径与元数据、真实分片索引、并发上限。
//
// 全部是 **mock 验证**：把 globalThis.fetch 换成可控的假实现，不访问外网。
// 真实联网验证单独记在 docs/fix-list.md 的「验证记录」里，两者不能混。
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import { danmaku, decodeDmSegConfig, DEFAULT_DANMAKU_CONCURRENCY, mapLimit } from '../src/bili.js';
import { fetchVideo } from '../src/fetch.js';

const BVID = 'BV1Test5P000';
const realFetch = globalThis.fetch;

// ── 造 protobuf ────────────────────────────────────────────────────────────

function varint(n) {
  const out = [];
  let v = n >>> 0;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return Buffer.from(out);
}

function tag(field, wire) {
  return varint((field << 3) | wire);
}

/** DmSegConfig { page_size=1, total=2 } */
function segConfig(pageSize, total) {
  return Buffer.concat([tag(1, 0), varint(pageSize), tag(2, 0), varint(total)]);
}

/** DmSegMobileReply { repeated DanmakuElem elems = 1 } */
function segReply(items) {
  const chunks = [];
  for (const it of items) {
    const elem = Buffer.concat([
      tag(2, 0), varint(Math.round(it.t * 1000)), // progress
      tag(3, 0), varint(1),                       // mode
      tag(7, 2), varint(Buffer.byteLength(it.content, 'utf8')), Buffer.from(it.content, 'utf8'),
    ]);
    chunks.push(tag(1, 2), varint(elem.length), elem);
  }
  return Buffer.concat(chunks);
}

// ── 假 B 站 ────────────────────────────────────────────────────────────────

function jsonResponse(obj) {
  return new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
}

/**
 * @param {object} o {
 *   pages: [{page,cid,title,duration}],
 *   subtitles?: [{lan,lanDoc,url,ai}],
 *   subtitleOk?: boolean,
 *   segByCid?: { [cid]: { pageSize, total, items: [[..per seg..]], failSegs?: number[] } },
 *   indexFail?: 'http500'|'json'|'empty',
 * }
 */
function makeServer(o = {}) {
  const calls = { index: 0, seg: [], subtitle: 0 };
  const pages = o.pages ?? [{ page: 1, cid: 111, title: '第一话', duration: 60 }];
  let inflight = 0;
  const stats = { maxInflight: 0 };

  const fn = async (url) => {
    const u = String(url);
    if (u.includes('/x/web-interface/view')) {
      return jsonResponse({
        code: 0,
        data: {
          bvid: BVID, aid: 999, title: '测试视频', owner: { name: 'UP' }, duration: 120, desc: '',
          pages: pages.map((p) => ({ page: p.page, cid: p.cid, part: p.title, duration: p.duration })),
        },
      });
    }
    if (u.includes('/x/player/v2')) {
      calls.subtitle += 1;
      // 真实的 B 站字段名是 subtitle_url（snake_case），不是 url
      const subs = (o.subtitles ?? []).map((s) => ({
        lan: s.lan,
        lan_doc: s.lanDoc ?? s.lan,
        subtitle_url: s.url,
        ai_type: s.ai ? 1 : 0,
      }));
      return jsonResponse({ code: 0, data: { subtitle: { subtitles: subs } } });
    }
    if (u.includes('subtitle.content.invalid') && o.subtitleOk === false) {
      return new Response('', { status: 500 });
    }
    if (u.includes('/subtitle/')) {
      return jsonResponse({ body: [{ from: 0.5, to: 1.5, content: 'The doctor will see the patient now' }] });
    }
    if (u.includes('/x/v2/dm/web/view')) {
      calls.index += 1;
      if (o.indexFail === 'http500') return new Response('', { status: 500 });
      if (o.indexFail === 'json') return jsonResponse({ code: -404, message: '啥都木有' });
      if (o.indexFail === 'empty') return new Response('', { status: 200 });
      const cid = Number(new URL(u).searchParams.get('oid'));
      const cfg = (o.segByCid ?? {})[cid];
      if (!cfg) return jsonResponse({ code: 0, message: 'ok' });
      return new Response(segConfig(cfg.pageSize ?? 6, cfg.total), { status: 200 });
    }
    if (u.includes('/x/v2/dm/web/seg.so')) {
      const q = new URL(u).searchParams;
      const cid = Number(q.get('oid'));
      const idx = Number(q.get('segment_index'));
      calls.seg.push({ cid, idx });
      inflight += 1;
      stats.maxInflight = Math.max(stats.maxInflight, inflight);
      // 让并发有机会真正重叠
      await new Promise((r) => setTimeout(r, 5));
      inflight -= 1;
      const cfg = (o.segByCid ?? {})[cid];
      if (!cfg) return new Response('', { status: 404 });
      if ((cfg.failSegs ?? []).includes(idx)) return new Response('', { status: 500 });
      const items = cfg.items?.[idx - 1] ?? [];
      return new Response(segReply(items), { status: 200 });
    }
    return new Response('', { status: 404 });
  };

  return { fetch: fn, calls, stats };
}

function withMockFetch(server) {
  globalThis.fetch = server.fetch;
}

// ── 测试 ───────────────────────────────────────────────────────────────────

let root;
let seq = 0;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'vd-t2-'));
});
after(() => {
  globalThis.fetch = realFetch;
  rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  globalThis.fetch = realFetch;
  seq += 1;
});

const workDir = () => join(root, `case-${seq}-${Math.random().toString(36).slice(2, 7)}`);

describe('T2 · DmSegConfig 解码', () => {
  it('能解出 page_size 与 total（裸 DmSegConfig）', () => {
    const r = decodeDmSegConfig(segConfig(6, 42));
    assert.equal(r.ok, true);
    assert.equal(r.pageSize, 6);
    assert.equal(r.total, 42);
  });

  it('能解出真实 DmView 里嵌在 field 4 的索引', () => {
    // 模拟真实响应：field 4 = DmSegConfig{1:360000, 2:100}
    const inner = segConfig(360000, 100);
    const view = Buffer.concat([tag(4, 2), varint(inner.length), inner]);
    const r = decodeDmSegConfig(view);
    assert.equal(r.ok, true);
    assert.equal(r.pageSize, 360000);
    assert.equal(r.total, 100);
  });

  it('DmView 里还夹着别的字段时也不受影响', () => {
    const inner = segConfig(360000, 2);
    const other = Buffer.concat([tag(14, 0), varint(7)]);
    const view = Buffer.concat([other, tag(4, 2), varint(inner.length), inner, other]);
    const r = decodeDmSegConfig(view);
    assert.equal(r.ok, true);
    assert.equal(r.total, 2);
  });

  it('内容不完整（total=0）明确报错，不假装 0 片', () => {
    const r = decodeDmSegConfig(segConfig(6, 0));
    assert.equal(r.ok, false);
    assert.match(r.error, /page_size=6 total=0/);
  });
});

describe('T2 · mapLimit 并发上限', () => {
  it('实际并发不超过给定值，且结果保持输入顺序', async () => {
    let inflight = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9], 3, async (n) => {
      inflight += 1;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 4));
      inflight -= 1;
      return n * 10;
    });
    assert.equal(peak, 3, `峰值并发应为 3，实际 ${peak}`);
    assert.deepEqual(out, [10, 20, 30, 40, 50, 60, 70, 80, 90]);
  });

  it('limit 比任务数大时不空转', async () => {
    const out = await mapLimit([1, 2], 8, async (n) => n);
    assert.deepEqual(out, [1, 2]);
  });
});

describe('T2 · 弹幕索引与分片', () => {
  it('按真实索引取片，片数等于索引里的 total（不是按时长估）', async () => {
    const server = makeServer({
      segByCid: { 111: { pageSize: 6, total: 3, items: [[{ t: 1, content: 'first' }], [{ t: 2, content: 'second' }], [{ t: 3, content: 'third' }]] } },
    });
    withMockFetch(server);
    const dm = await danmaku({ cid: 111, aid: 999, bvid: BVID, concurrency: 2 });
    assert.equal(dm.ok, true);
    assert.equal(dm.total, 3);
    assert.equal(dm.count, 3);
    assert.deepEqual(dm.items.map((i) => i.content), ['first', 'second', 'third']);
    assert.deepEqual(server.calls.seg.map((c) => c.idx).sort(), [1, 2, 3]);
  });

  it('索引失败要报错（index 阶段），不能返回零条', async () => {
    for (const mode of ['http500', 'json', 'empty']) {
      const server = makeServer({ indexFail: mode });
      withMockFetch(server);
      const dm = await danmaku({ cid: 111, concurrency: 2 });
      assert.equal(dm.ok, false, `${mode} 应失败`);
      assert.equal(dm.stage, 'index');
      assert.ok(dm.error && dm.error.length > 0, `${mode} 要有错误信息`);
    }
  });

  it('JSON 错误体里的 code 会带出来', async () => {
    withMockFetch(makeServer({ indexFail: 'json' }));
    const dm = await danmaku({ cid: 111 });
    assert.match(dm.error, /code=-404/);
  });

  it('部分分片失败：仍然返回结果，但 failed 里记着是哪些片', async () => {
    const server = makeServer({
      segByCid: { 111: { pageSize: 6, total: 4, failSegs: [2, 4], items: [[{ t: 1, content: 'a' }], null, [{ t: 3, content: 'c' }], null] } },
    });
    withMockFetch(server);
    const dm = await danmaku({ cid: 111, concurrency: 2 });
    assert.equal(dm.ok, true);
    assert.equal(dm.count, 2);
    assert.equal(dm.fetched, 2);
    assert.deepEqual(dm.failed.map((f) => f.segment).sort(), [2, 4]);
  });

  it('全部分片失败：报错而不是「0 条弹幕」', async () => {
    const server = makeServer({
      segByCid: { 111: { pageSize: 6, total: 3, failSegs: [1, 2, 3], items: [null, null, null] } },
    });
    withMockFetch(server);
    const dm = await danmaku({ cid: 111, concurrency: 2 });
    assert.equal(dm.ok, false);
    assert.equal(dm.stage, 'segments');
    assert.match(dm.error, /全部 3 个分片/);
  });

  it('默认并发不超过 DEFAULT_DANMAKU_CONCURRENCY', async () => {
    const total = 12;
    const server = makeServer({
      segByCid: { 111: { pageSize: 6, total, items: Array.from({ length: total }, (_, i) => [{ t: i + 1, content: `s${i + 1}` }]) } },
    });
    withMockFetch(server);
    await danmaku({ cid: 111 });
    assert.ok(server.stats.maxInflight <= DEFAULT_DANMAKU_CONCURRENCY, `峰值 ${server.stats.maxInflight} 超过 ${DEFAULT_DANMAKU_CONCURRENCY}`);
  });

  it('显式并发上限生效（请求 3 → 峰值不超过 3）', async () => {
    const total = 10;
    const server = makeServer({
      segByCid: { 111: { pageSize: 6, total, items: Array.from({ length: total }, (_, i) => [{ t: i + 1, content: `s${i + 1}` }]) } },
    });
    withMockFetch(server);
    const dm = await danmaku({ cid: 111, concurrency: 3 });
    assert.equal(dm.count, total);
    assert.ok(server.stats.maxInflight <= 3, `峰值 ${server.stats.maxInflight} 超过 3`);
  });
});

describe('T2 · fetchVideo 弹幕开关', () => {
  const pages2 = [
    { page: 1, cid: 111, title: '第一话', duration: 60 },
    { page: 2, cid: 222, title: '第二话', duration: 70 },
  ];

  function serverWithSubsAndDanmaku() {
    return makeServer({
      pages: pages2,
      subtitles: [{ lan: 'en', lanDoc: 'English', url: 'https://example.test/subtitle/en.json', ai: false }],
      segByCid: {
        111: { pageSize: 6, total: 2, items: [[{ t: 1, content: 'hello' }], [{ t: 2, content: 'world' }]] },
        222: { pageSize: 6, total: 2, items: [[{ t: 1, content: 'second page line' }], [{ t: 3, content: 'another' }]] },
      },
    });
  }

  it('默认：抓弹幕但弹幕不进 inputs', async () => {
    const server = serverWithSubsAndDanmaku();
    withMockFetch(server);
    const cwd = workDir();
    const r = await fetchVideo({ link: `https://www.bilibili.com/video/${BVID}`, cwd });
    assert.equal(r.ok, true);
    assert.ok(r.danmaku > 0, '应该抓到了弹幕');
    assert.equal(r.withDanmaku, false);
    assert.equal(r.inputs.length, 1);
    assert.match(r.inputs[0], /subtitle\.srt$/);
    assert.ok(existsSync(r.danmakuFile), '弹幕文件应落地');
  });

  it('withDanmaku=true：弹幕进 inputs', async () => {
    withMockFetch(serverWithSubsAndDanmaku());
    const cwd = workDir();
    const r = await fetchVideo({ link: `https://www.bilibili.com/video/${BVID}`, cwd, withDanmaku: true });
    assert.equal(r.ok, true);
    assert.equal(r.inputs.length, 2);
    assert.ok(r.inputs.some((p) => /danmaku\.txt$/.test(p)));
  });

  it('fetchDanmaku=false：完全不请求弹幕接口，弹幕只字不提', async () => {
    const server = serverWithSubsAndDanmaku();
    withMockFetch(server);
    const r = await fetchVideo({ link: `https://www.bilibili.com/video/${BVID}`, cwd: workDir(), fetchDanmaku: false });
    assert.equal(r.ok, true);
    assert.equal(server.calls.index, 0, '不该请求索引');
    assert.equal(server.calls.seg.length, 0, '不该请求分片');
    assert.equal(r.danmaku, 0);
    assert.equal(r.danmakuInfo.requested, false);
  });

  it('fetchDanmaku=false 时 withDanmaku=true 也不会凭空多出弹幕输入', async () => {
    withMockFetch(serverWithSubsAndDanmaku());
    const r = await fetchVideo({
      link: `https://www.bilibili.com/video/${BVID}`, cwd: workDir(), fetchDanmaku: false, withDanmaku: true,
    });
    assert.equal(r.ok, true);
    assert.equal(r.inputs.length, 1);
  });

  it('弹幕部分分片失败：顶层带 warning，不伪装成完整', async () => {
    const server = makeServer({
      pages: pages2,
      subtitles: [{ lan: 'en', lanDoc: 'English', url: 'https://example.test/subtitle/en.json', ai: false }],
      segByCid: { 111: { pageSize: 6, total: 3, failSegs: [2], items: [[{ t: 1, content: 'x' }], null, [{ t: 3, content: 'z' }]] } },
    });
    withMockFetch(server);
    const r = await fetchVideo({ link: `https://www.bilibili.com/video/${BVID}`, cwd: workDir() });
    assert.equal(r.ok, true);
    assert.ok(r.danmakuInfo.failed.length > 0);
    assert.match(String(r.danmakuInfo.warning), /1\/3 个分片/);
  });

  it('弹幕接口整个失败：danmakuInfo.ok=false 且带 error', async () => {
    const server = makeServer({
      pages: pages2,
      subtitles: [{ lan: 'en', lanDoc: 'English', url: 'https://example.test/subtitle/en.json', ai: false }],
      indexFail: 'http500',
    });
    withMockFetch(server);
    const r = await fetchVideo({ link: `https://www.bilibili.com/video/${BVID}`, cwd: workDir() });
    assert.equal(r.ok, true, '有字幕时整体仍应成功');
    assert.equal(r.danmakuInfo.ok, false);
    assert.match(String(r.danmakuInfo.error), /索引接口 HTTP 500/);
  });
});

describe('T2 · 多 P：真实路径与元数据', () => {
  const pages3 = [
    { page: 1, cid: 111, title: '第一话', duration: 60 },
    { page: 2, cid: 222, title: '第二话', duration: 70 },
    { page: 3, cid: 333, title: '第三话', duration: 80 },
  ];

  function serverPaged() {
    return makeServer({
      pages: pages3,
      subtitles: [{ lan: 'en', lanDoc: 'English', url: 'https://example.test/subtitle/en.json', ai: false }],
      segByCid: {
        222: { pageSize: 6, total: 1, items: [[{ t: 5, content: 'p2 danmaku' }]] },
      },
    });
  }

  it('P2：返回的每个 inputs 都真实存在', async () => {
    withMockFetch(serverPaged());
    const r = await fetchVideo({ link: `https://www.bilibili.com/video/${BVID}?p=2`, cwd: workDir(), withDanmaku: true });
    assert.equal(r.ok, true);
    assert.equal(r.page, 2);
    for (const p of r.inputs) {
      assert.ok(existsSync(p), `路径不存在：${p}`);
    }
  });

  it('P2：page / cid / playUrl 通过 meta.json 与返回值贯通', async () => {
    withMockFetch(serverPaged());
    const r = await fetchVideo({ link: `https://www.bilibili.com/video/${BVID}?p=2`, cwd: workDir() });
    assert.equal(r.page, 2);
    assert.equal(r.cid, 222);
    assert.equal(r.playUrl, `https://www.bilibili.com/video/${BVID}?p=2`);
    const meta = JSON.parse(readFileSync(r.metaFile, 'utf8'));
    assert.equal(meta.page, 2);
    assert.equal(meta.cid, 222);
    assert.equal(meta.playUrl, `https://www.bilibili.com/video/${BVID}?p=2`);
    assert.equal(meta.pageTitle, '第二话');
    assert.equal(meta.totalPages, 3);
  });

  it('P2：目录名带 .p2', async () => {
    withMockFetch(serverPaged());
    const r = await fetchVideo({ link: `https://www.bilibili.com/video/${BVID}?p=2`, cwd: workDir() });
    assert.match(r.dir, /\.p2$/);
  });

  it('越界 P 明确报错，且不退回第 1 P', async () => {
    withMockFetch(serverPaged());
    const r = await fetchVideo({ link: `https://www.bilibili.com/video/${BVID}?p=9`, cwd: workDir() });
    assert.equal(r.ok, false);
    assert.match(r.error, /没有第 9 P（共 3 P）/);
  });

  it('非法 P 号（0）报错', async () => {
    withMockFetch(serverPaged());
    const r = await fetchVideo({ link: `https://www.bilibili.com/video/${BVID}`, cwd: workDir(), page: 0 });
    assert.equal(r.ok, false);
    assert.match(r.error, /分 P 号不合法/);
  });

  it('单 P 视频：playUrl 不带 ?p=', async () => {
    withMockFetch(makeServer({
      pages: [{ page: 1, cid: 111, title: '全片', duration: 60 }],
      subtitles: [{ lan: 'en', lanDoc: 'English', url: 'https://example.test/subtitle/en.json', ai: false }],
    }));
    const r = await fetchVideo({ link: `https://www.bilibili.com/video/${BVID}`, cwd: workDir() });
    assert.equal(r.ok, true);
    assert.equal(r.playUrl, `https://www.bilibili.com/video/${BVID}`);
    assert.equal(r.totalPages, 1);
  });

  it('inputs 是真实路径，labels 才是带 .p2 的展示标签', async () => {
    withMockFetch(serverPaged());
    const r = await fetchVideo({ link: `https://www.bilibili.com/video/${BVID}?p=2`, cwd: workDir() });
    assert.equal(r.inputs.length, 1);
    assert.ok(existsSync(r.inputs[0]));
    assert.match(r.labels[0], /\.p2\.srt$/);
    assert.notEqual(r.inputs[0], r.labels[0], '标签不能当路径返回');
  });
});

describe('T2 · 只有弹幕的视频', () => {
  it('只有弹幕且没开 withDanmaku：报错并说明原因', async () => {
    withMockFetch(makeServer({
      pages: [{ page: 1, cid: 111, title: '全片', duration: 60 }],
      subtitles: [],
      segByCid: { 111: { pageSize: 6, total: 1, items: [[{ t: 1, content: 'only danmaku' }]] } },
    }));
    const r = await fetchVideo({
      link: `https://www.bilibili.com/video/${BVID}`, cwd: workDir(), asr: false,
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /只有弹幕/);
    assert.equal(r.danmaku.ok, true);
  });

  it('只有弹幕 + withDanmaku：能成功', async () => {
    withMockFetch(makeServer({
      pages: [{ page: 1, cid: 111, title: '全片', duration: 60 }],
      subtitles: [],
      segByCid: { 111: { pageSize: 6, total: 1, items: [[{ t: 1, content: 'only danmaku' }]] } },
    }));
    const r = await fetchVideo({
      link: `https://www.bilibili.com/video/${BVID}`, cwd: workDir(), asr: false, withDanmaku: true,
    });
    assert.equal(r.ok, true);
    assert.equal(r.inputs.length, 1);
    assert.ok(existsSync(r.inputs[0]));
  });

  it('没字幕 + 弹幕接口失败：报「取数失败」而不是「零条弹幕」', async () => {
    withMockFetch(makeServer({
      pages: [{ page: 1, cid: 111, title: '全片', duration: 60 }],
      subtitles: [],
      indexFail: 'http500',
    }));
    const r = await fetchVideo({
      link: `https://www.bilibili.com/video/${BVID}`, cwd: workDir(), asr: false,
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /弹幕也没取到.*不是「零条弹幕」/);
  });
});
