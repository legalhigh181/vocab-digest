/**
 * T6 · Web 端长任务：不阻塞探活、可取消、并发隔离
 *
 * 这里不真的抓 B 站、也不真的转写：
 *   startApp({ fetchVideo }) 允许注入取数实现，测试注入一个「永远不会自己结束」的假实现，
 *   用来验证真实世界里最要紧的几件事——
 *     · ASR 跑着的几分钟里，服务还能正常响应其它请求（不是单线程卡死）
 *     · 任务出现在 /api/tasks 里，能被 /api/tasks/cancel 单独干掉
 *     · 取消后 abort 信号真的传到了任务里（没有变成「点了取消但后台还在跑」）
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startApp } from '../src/app/server.js';
import { __setCollisionLog, __setHook, __setRunIdFactory, makeRunId, runDigest } from '../src/run.js';

const tmp = mkdtempSync(join(tmpdir(), 'vocab-t6-tasks-'));
const servers = [];
after(() => {
  for (const s of servers) {
    try { s.server.close(); } catch { /* 已关 */ }
  }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows 偶发占用 */ }
});

async function boot(opts = {}) {
  const cwd = mkdtempSync(join(tmp, 'ws-'));
  const app = await startApp({ cwd, port: 0, ...opts });
  servers.push(app);
  return app;
}

async function post(app, path, body) {
  const r = await fetch(new URL(path, app.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return r.json();
}

async function get(app, path) {
  const r = await fetch(new URL(path, app.url));
  return r.json();
}

/** 假取数：一直等到 signal 被 abort 才结束，模拟「正在跑几分钟的 ASR」 */
function slowFetchVideo() {
  const seen = { started: 0, aborted: 0, args: [] };
  const impl = async (opts) => {
    seen.started += 1;
    seen.args.push({ outDir: opts.outDir, signal: Boolean(opts.signal) });
    await new Promise((res) => {
      const t = setTimeout(res, 60000);
      opts.signal?.addEventListener?.('abort', () => {
        seen.aborted += 1;
        clearTimeout(t);
        res();
      }, { once: true });
    });
    return { ok: false, error: '被取消', code: 'CANCELLED', dir: opts.outDir, written: [] };
  };
  return { impl, seen };
}

test('T6 · 取数任务在跑时服务仍然能响应（探活不被阻塞）', async () => {
  const app = await boot();
  const slow = slowFetchVideo();
  app.setFetchVideo(slow.impl);
  const p = post(app, '/api/run/fetch', { link: 'BV1GJ411x7h7', page: 1 });
  // 给任务一点时间真的起来
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(slow.seen.started, 1, '任务应该已经启动');

  const t0 = Date.now();
  const st = await get(app, '/api/state');
  const elapsed = Date.now() - t0;
  assert.equal(st.ok, true, '任务跑着的时候 /api/state 必须还能回');
  assert.ok(elapsed < 2000, `/api/state 被拖慢了：${elapsed}ms`);

  const tasks = await get(app, '/api/tasks');
  assert.equal(tasks.ok, true);
  assert.equal(tasks.tasks.length, 1, '正在跑的任务要能被列出来');
  assert.equal(tasks.tasks[0].kind, 'fetch');

  // 收尾：取消，避免测试进程挂着
  await post(app, '/api/tasks/cancel', { id: tasks.tasks[0].id });
  const done = await p;
  assert.equal(done.ok, false);
});

test('T6 · 取消能把 abort 真传进任务，其他任务不受影响', async () => {
  const app = await boot();
  const slow = slowFetchVideo();
  app.setFetchVideo(slow.impl);
  const p1 = post(app, '/api/run/fetch', { link: 'BV1GJ411x7h7', page: 1 });
  const p2 = post(app, '/api/run/fetch', { link: 'BV1GJ411x7h7', page: 2 });
  await new Promise((r) => setTimeout(r, 200));
  const tasks = await get(app, '/api/tasks');
  assert.equal(tasks.tasks.length, 2, '两个并发任务各自登记');

  const victim = tasks.tasks[0];
  const r = await post(app, '/api/tasks/cancel', { id: victim.id });
  assert.equal(r.ok, true);
  await p1;
  assert.equal(slow.seen.aborted >= 1, true, '被取消的任务必须真的收到 abort');

  // 另一个还在
  const still = await get(app, '/api/tasks');
  assert.equal(still.tasks.length, 1, '取消一个不能把另一个也干掉');

  await post(app, '/api/tasks/cancel', { id: still.tasks[0].id });
  await p2;
});

test('T6 · 取消不存在的任务返回明确失败而不是静默成功', async () => {
  const app = await boot();
  const r = await post(app, '/api/tasks/cancel', { id: '不存在' });
  assert.equal(r.ok, false);
  assert.ok(String(r.message).length > 0);
});

// ── 新接口：立刻返回 taskId（m01535 第 1 点）────────────────────────
// 老接口 /api/run/fetch 要等整件事做完才返回，等拿到 taskId 时已经没什么可取消的了。
// 所以另开一个 start 接口：立刻给 id，任务在后台跑。

test('T6 · /api/run/fetch/start 立刻返回 taskId，此时任务还在跑', async () => {
  const app = await boot();
  const slow = slowFetchVideo();
  app.setFetchVideo(slow.impl);
  const t0 = Date.now();
  const started = await post(app, '/api/run/fetch/start', { link: 'BV1GJ411x7h7', page: 1 });
  const elapsed = Date.now() - t0;
  assert.equal(started.ok, true);
  assert.ok(started.taskId, '必须立刻给出 taskId');
  assert.ok(elapsed < 1500, `start 不该等任务做完：${elapsed}ms`);

  try {
    // 这个 id 拿出来的时候，任务确实还在跑——取消才有意义
    const one = await get(app, `/api/tasks?id=${encodeURIComponent(started.taskId)}`);
    assert.equal(one.ok, true);
    assert.equal(one.task.done, false, '刚启动时任务应当未完成');
    assert.equal(one.task.kind, 'fetch');
  } finally {
    await post(app, '/api/tasks/cancel', { id: started.taskId });
  }
  assert.equal(slow.seen.aborted, 1, '用 start 给的 id 必须能取消到真任务');
});

test('T6 · start 之后轮询同一个 id 能拿到最终结果（成功路径也一样）', async () => {
  const app = await boot();
  let released;
  const gate = new Promise((r) => { released = r; });
  app.setFetchVideo(async (opts) => {
    await gate;
    return {
      ok: true, dir: opts.outDir, subtitle: 3, danmaku: 1, asr: null,
      inputs: [join(opts.outDir, 'audio.p1.srt')], labels: ['p1'],
      page: 1, totalPages: 1, cid: 'x', playUrl: '', info: { title: '样例' },
      danmakuInfo: { ok: true }, danmakuFile: '',
    };
  });
  const started = await post(app, '/api/run/fetch/start', { link: 'BV1GJ411x7h7', page: 1 });
  const mid = await get(app, `/api/tasks?id=${encodeURIComponent(started.taskId)}`);
  assert.equal(mid.task.done, false);
  released();
  // 轮询到结束
  let task = null;
  for (let i = 0; i < 60; i += 1) {
    const r = await get(app, `/api/tasks?id=${encodeURIComponent(started.taskId)}`);
    if (r.ok && r.task.done) { task = r.task; break; }
    await new Promise((res) => setTimeout(res, 50));
  }
  assert.ok(task, '任务应当能在 3 秒内结束');
  assert.equal(task.result.ok, true, '结果要随任务一起带回来');
  assert.equal(task.result.taskId, started.taskId);
});

test('T6 · 老接口 /api/run/fetch 的契约没变：等做完再返回，结果结构一致', async () => {
  const app = await boot();
  app.setFetchVideo(async (opts) => ({
    ok: true, dir: opts.outDir, subtitle: 2, danmaku: 0, asr: null,
    inputs: [join(opts.outDir, 'audio.p1.srt')], labels: ['p1'],
    page: 1, totalPages: 1, cid: 'x', playUrl: '', info: { title: '样例' },
    danmakuInfo: { ok: false, error: '没有弹幕' }, danmakuFile: '',
  }));
  const r = await post(app, '/api/run/fetch', { link: 'BV1GJ411x7h7', page: 1 });
  assert.equal(r.ok, true);
  assert.ok(r.taskId, '老接口也要带上 taskId（新增字段，不影响老调用方）');
  assert.ok(Array.isArray(r.inputs) && r.inputs.length === 1);
  assert.equal(typeof r.message, 'string');
  // 做完之后任务应该已经离开「正在跑」列表
  const tasks = await get(app, '/api/tasks');
  assert.equal(tasks.tasks.length, 0);
});

test('T6 · 取数请求里的 language 必须传到转写层（否则日语会被当成英语转写）', async () => {
  const app = await boot();
  const seen = [];
  app.setFetchVideo(async (opts) => {
    seen.push(opts.language);
    return {
      ok: true, dir: opts.outDir, subtitle: 1, danmaku: 0, asr: null,
      inputs: [join(opts.outDir, 'audio.p1.srt')], labels: ['p1'],
      page: 1, totalPages: 1, cid: 'x', playUrl: '', info: { title: '样例' },
      danmakuInfo: { ok: false, error: '没有弹幕' }, danmakuFile: '',
    };
  });
  // 显式传 ja：必须原样到转写层
  await post(app, '/api/run/fetch', { link: 'BV1GJ411x7h7', page: 1, language: 'ja' });
  // 不传：交给下游默认（en），但必须是显式 undefined 而不是别的东西
  await post(app, '/api/run/fetch', { link: 'BV1GJ411x7h7', page: 1 });
  assert.deepEqual(seen, ['ja', undefined]);
});

test('T6 · 两个并发任务各用各的目录（同视频不同 P 不互相覆盖）', async () => {
  const app = await boot();
  const slow = slowFetchVideo();
  app.setFetchVideo(slow.impl);
  const p1 = post(app, '/api/run/fetch', { link: 'BV1GJ411x7h7', page: 1 });
  const p2 = post(app, '/api/run/fetch', { link: 'BV1GJ411x7h7', page: 2 });
  await new Promise((r) => setTimeout(r, 200));
  const dirs = slow.seen.args.map((a) => a.outDir);
  assert.equal(dirs.length, 2);
  assert.notEqual(dirs[0], dirs[1], `两个 P 必须落在不同目录，实际：${dirs.join(' / ')}`);
  assert.ok(dirs[0].endsWith('.p1') && dirs[1].endsWith('.p2'));

  const tasks = await get(app, '/api/tasks');
  for (const t of tasks.tasks) await post(app, '/api/tasks/cancel', { id: t.id });
  await Promise.all([p1, p2]);
});

test('T6 · 运行 ID 唯一性：并发分配下来的目录全部互不相同', async () => {
  const cwd = mkdtempSync(join(tmp, 'ids-'));
  const srt = join(cwd, 'a.srt');
  writeFileSync(srt, '1\r\n00:00:01,000 --> 00:00:03,000\r\nhello world\r\n', 'utf8');
  const N = 12;
  const rs = await Promise.all(Array.from({ length: N }, () => runDigest({ inputs: [srt], cwd, language: 'en' })));
  const ids = rs.map((r) => r.runId);
  const dirs = rs.map((r) => r.runDir);
  assert.equal(new Set(ids).size, N, `分配的 runId 必须全部唯一，实际 ${new Set(ids).size}/${N}`);
  assert.equal(new Set(dirs.map((d) => d.toLowerCase())).size, N, '目录也必须全部唯一');
  for (const d of dirs) assert.ok(existsSync(join(d, 'digest.json')), '每个目录都要有自己的结果');
  assert.match(makeRunId(new Date('2026-11-10T15:00:00')), /^\d{8}-\d{6}-[a-z0-9]{4}$/);
});

test('T6 · 强制碰撞：自动分配撞到已有目录时换新 ID，最终目录唯一', () => {
  const cwd = mkdtempSync(join(tmp, 'collide-'));
  const srt = join(cwd, 'a.srt');
  writeFileSync(srt, '1\r\n00:00:01,000 --> 00:00:03,000\r\nhello world\r\n', 'utf8');
  const collisions = [];
  const CLAIMED = '20261110-000000-aaaa';
  const FREE = '20261110-000000-bbbb';
  try {
    // 先把 CLAIMED 占掉（正常跑一次，这同时也是「目录已存在」的场景）
    const occupied = runDigest({ inputs: [srt], cwd, runId: CLAIMED, language: 'en' });
    assert.equal(occupied.runId, CLAIMED);

    // 自动分配：第一次给 CLAIMED（必然撞），之后给 FREE
    let calls = 0;
    __setRunIdFactory(() => {
      calls += 1;
      return calls === 1 ? CLAIMED : FREE;
    });
    __setCollisionLog(collisions);
    const r = runDigest({ inputs: [srt], cwd, language: 'en' });
    assert.equal(calls, 2, `应恰好重试一次，实际取了 ${calls} 次 ID`);
    assert.deepEqual(collisions, [CLAIMED], '撞到的那次要留痕');
    assert.equal(r.runId, FREE, '结果必须落在换出来的新 ID 上');
    assert.ok(existsSync(join(r.runDir, 'digest.json')));
    // 原来那份不能被碰
    assert.equal(existsSync(join(occupied.runDir, 'digest.json')), true, '被撞的那次结果必须完好');
  } finally {
    __setRunIdFactory(null);
    __setCollisionLog(null);
  }
});

test('T6 · 显式 runId：默认不许覆盖已有目录；带 overwrite 才能覆盖', async () => {
  const cwd = mkdtempSync(join(tmp, 'explicit-'));
  const srt = join(cwd, 'a.srt');
  writeFileSync(srt, '1\r\n00:00:01,000 --> 00:00:03,000\r\nhello world\r\n', 'utf8');
  const first = runDigest({ inputs: [srt], cwd, runId: 'fixed-1', language: 'en' });
  const digestBefore = readFileSync(join(first.runDir, 'digest.json'), 'utf8');

  // 1) 目录已存在 + 没给 overwrite → 冲突，且一个字节都不能改
  const e1 = await Promise.resolve()
    .then(() => runDigest({ inputs: [srt], cwd, runId: 'fixed-1', language: 'en' }))
    .then(() => null, (e) => e);
  assert.equal(e1?.code, 'RUN_DIR_CONFLICT');
  assert.equal(e1?.reason, 'exists');
  assert.equal(readFileSync(join(first.runDir, 'digest.json'), 'utf8'), digestBefore);

  // 2) 显式 overwrite 才能覆盖
  const ok = runDigest({ inputs: [srt], cwd, runId: 'fixed-1', language: 'en', overwrite: true });
  assert.equal(ok.runId, 'fixed-1');
});

test('T6 · 运行进行中：同一个 runId 就算带 overwrite 也抢不走', () => {
  const cwd = mkdtempSync(join(tmp, 'busy-'));
  const srt = join(cwd, 'a.srt');
  writeFileSync(srt, '1\r\n00:00:01,000 --> 00:00:03,000\r\nhello world\r\n', 'utf8');
  let inner = null;
  // 在「已经占了目录、还没跑完」的窗口里再抢一次同一个 runId
  __setHook({
    afterClaim: () => {
      inner = (() => {
        try { return { ok: runDigest({ inputs: [srt], cwd, runId: 'busy-1', language: 'en', overwrite: true }) }; } catch (e) { return { err: e }; }
      })();
    },
  });
  try {
    const outer = runDigest({ inputs: [srt], cwd, runId: 'busy-1', language: 'en' });
    assert.equal(outer.runId, 'busy-1');
  } finally {
    __setHook(null);
  }
  assert.ok(inner, '钩子应该被触发过');
  assert.equal(inner.err?.code, 'RUN_DIR_CONFLICT', `运行中必须拒绝，实际：${inner.ok ? '竟然成功' : inner.err?.code}`);
  assert.equal(inner.err?.reason, 'busy');
  assert.equal(existsSync(join(cwd, 'runs', 'busy-1', 'digest.json')), true, '原来那次的结果不能被破坏');
});

test('T6 · 并发跑两个日文 digest：各写各的运行目录', async () => {
  const cwd = mkdtempSync(join(tmp, 'runs-'));
  const srt = join(cwd, 'a.srt');
  writeFileSync(srt, '1\r\n00:00:01,000 --> 00:00:03,000\r\n日本の学生は勉強します。\r\n', 'utf8');
  const { runDigestAsync } = await import('../src/run.js');
  const [ra, rb] = await Promise.all([
    runDigestAsync({ inputs: [srt], cwd, language: 'ja' }),
    runDigestAsync({ inputs: [srt], cwd, language: 'ja' }),
  ]);
  assert.notEqual(ra.runId, rb.runId, '两个并发运行不能拿到同一个 ID');
  assert.notEqual(ra.runDir, rb.runDir);
});

test('T6 · 显式指定已存在的运行 ID 时必须报冲突，不能静默覆盖', () => {
  const cwd = mkdtempSync(join(tmp, 'explicit2-'));
  const srt = join(cwd, 'a.srt');
  writeFileSync(srt, '1\r\n00:00:01,000 --> 00:00:03,000\r\nhello world\r\n', 'utf8');
  const first = runDigest({ inputs: [srt], cwd, runId: 'fixed-1', language: 'en' });
  const before = readFileSync(join(first.runDir, 'digest.json'), 'utf8');
  let caught = null;
  try {
    runDigest({ inputs: [srt], cwd, runId: 'fixed-1', language: 'en' });
  } catch (e) {
    caught = e;
  }
  assert.equal(caught?.code, 'RUN_DIR_CONFLICT');
  assert.equal(caught?.reason, 'exists');
  assert.equal(readFileSync(join(first.runDir, 'digest.json'), 'utf8'), before, '被拒时原结果一个字节都不能变');
});
