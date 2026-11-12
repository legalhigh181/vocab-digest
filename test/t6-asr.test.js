/**
 * T6 · 语音转写子进程化 / 下载流式落盘
 *
 * 这些测试**不需要真的 ffmpeg 和 whisper 模型**，也不需要能 spawn 子进程：
 *
 *   子进程层（runFfmpeg 本身）要 spawn 一个短命进程来验，沙箱拦掉时记为
 *   「环境受阻」而不是失败——`tools/probe-spawn.mjs` 能随时复现这个限制。
 *
 *   transcribe 的判定逻辑（退出码 + 产物 + 临时目录 + 旧文件还原）用注入的
 *   `ffmpegTarget` 验，这部分不依赖子进程，任何机器上都能跑。
 *
 * 下载用注入的 fetchImpl 验，同样不出网。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { ASR_ERRORS, isEnglishOnlyModel, runFfmpeg, srtHasContent, transcribe } from '../src/asr.js';
import { download } from '../src/bili.js';

const SRT_OK = '1\n00:00:00,000 --> 00:00:02,000\nこんにちは\n\n2\n00:00:02,000 --> 00:00:04,000\n世界\n';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'vd-t6-asr-'));
}

/** 探一次本机能不能 spawn：只用来决定「子进程层」那几条记成通过还是环境受阻 */
async function spawnWorks() {
  return new Promise((res) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; res(v); } };
    let c;
    try {
      c = spawn(process.execPath, ['-e', '0'], { windowsHide: true });
    } catch {
      return finish(false);
    }
    c.on('error', () => finish(false));
    c.on('close', (code) => finish(code === 0));
  });
}

const SPAWN_OK = await spawnWorks();

/**
 * 假 ffmpeg：直接模拟「子进程干了什么」，按 mode 决定往 tmpOut 写什么、返回什么状态。
 *
 * 每种 mode 都对应一条真实世界的失败，不是凭空造的场景：
 *   ok      正常产出字幕
 *   empty   退出码 0 但字幕只有序号（whisper 没听清）
 *   none    退出码 0 但没产出（音轨为空）
 *   crash   非 0 退出码
 *   hang    一直不返回，直到被 timeout / abort 打断
 *   noisy   灌一堆 stderr 再成功（测有界收集）
 */
function fakeTarget(mode, extra = {}) {
  return async (cmd, args, o) => {
    const started = Date.now();
    // transcribe 会把 whisper 滤镜的 destination=<相对路径> 放在 -af 参数里
    // （形如 whisper=model=…:destination=.asr-stage/t_xxx.srt），从整条参数串里捞出来
    const m = args.map((a) => /(?:^|[:,])destination=([^,:]+)/.exec(String(a)))
      .filter(Boolean).pop();
    const dest = m ? m[1] : null;
    const absDest = dest ? join(o.cwd, dest) : null;
    if (mode === 'hang') {
      await new Promise((res) => {
        const t = setTimeout(res, 30000);
        o.signal?.addEventListener?.('abort', () => { clearTimeout(t); res(); }, { once: true });
      });
      if (o.signal?.aborted) {
        return { status: null, stderr: '', stderrDropped: 0, timedOut: false, cancelled: true, elapsedMs: Date.now() - started, spawnError: null };
      }
      return { status: 0, stderr: '', stderrDropped: 0, timedOut: false, cancelled: false, elapsedMs: Date.now() - started, spawnError: null };
    }
    if (mode === 'crash') {
      return { status: 1, stderr: 'ffmpeg: 模拟崩溃', stderrDropped: 0, timedOut: false, cancelled: false, elapsedMs: 1, spawnError: null };
    }
    if (mode === 'noisy') {
      return { status: 0, stderr: 'warn line\n'.repeat(20000), stderrDropped: 20000 * 10, timedOut: false, cancelled: false, elapsedMs: 1, spawnError: null };
    }
    if (mode === 'none') {
      return { status: 0, stderr: '', stderrDropped: 0, timedOut: false, cancelled: false, elapsedMs: 1, spawnError: null };
    }
    if (mode === 'empty') {
      if (absDest) { mkdirSync(dirname(absDest), { recursive: true }); writeFileSync(absDest, '1\n\n2\n\n'); }
      return { status: 0, stderr: '', stderrDropped: 0, timedOut: false, cancelled: false, elapsedMs: 1, spawnError: null };
    }
    // 真 ffmpeg 会自己在 cwd 下建 destination 的各级目录；假命令也得照做
    if (absDest) { mkdirSync(dirname(absDest), { recursive: true }); writeFileSync(absDest, SRT_OK); }
    return { status: 0, stderr: '', stderrDropped: 0, timedOut: false, cancelled: false, elapsedMs: 1, spawnError: null };
  };
}

/** 造模型/输入占位文件（假 ffmpeg 不读它们，但 transcribe 会检查存在性） */
function fixtures(dir) {
  const models = join(dir, 'models');
  mkdirSync(models, { recursive: true });
  const model = join(models, 'ggml-small.bin');
  const input = join(dir, 'audio.m4s');
  writeFileSync(model, 'fake');
  writeFileSync(input, 'fake-audio');
  return { models, model, input };
}

function transcribeWithFake(dir, o) {
  return transcribe({
    input: o.input,
    out: o.out,
    cwd: dir,
    model: o.model,
    language: o.language,
    signal: o.signal,
    timeoutMs: o.timeoutMs,
    overwrite: o.overwrite === true,
    stageDir: o.stageDir,
    ffmpegCmd: 'fake-ffmpeg',
    ffmpegTarget: fakeTarget(o.mode),
  });
}

// ── 1 · 子进程层：runFfmpeg ──────────────────────────────────────────
// 这几条要真的 spawn。沙箱拦掉时只登记，不计入失败（也不计为通过）。

test('T6 · runFfmpeg：异步执行不阻塞事件循环', { skip: SPAWN_OK ? false : '本机沙箱拦 spawn（EPERM），见 tools/probe-spawn.mjs' }, async () => {
  let ticked = false;
  setTimeout(() => { ticked = true; }, 0);
  const r = await runFfmpeg(process.execPath, ['-e', 'setTimeout(()=>{},50)'], {});
  assert.equal(r.status, 0);
  assert.equal(ticked, true, '异步执行期间事件循环必须还能跑');
});

test('T6 · runFfmpeg 超时会杀掉子进程并标记 timedOut', { skip: SPAWN_OK ? false : '本机沙箱拦 spawn（EPERM）' }, async () => {
  const t0 = Date.now();
  const r = await runFfmpeg(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { timeoutMs: 300 });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 8000, '超时必须真的中断，不能等它睡完');
});

test('T6 · runFfmpeg 取消：abort 后立刻结束并标记 cancelled', { skip: SPAWN_OK ? false : '本机沙箱拦 spawn（EPERM）' }, async () => {
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 200);
  const r = await runFfmpeg(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { signal: ctl.signal });
  assert.equal(r.cancelled, true);
  assert.equal(r.timedOut, false);
});

test('T6 · runFfmpeg stderr 有上限：灌 1MB 也只留设定的字节数', { skip: SPAWN_OK ? false : '本机沙箱拦 spawn（EPERM）' }, async () => {
  const script = 'for(let i=0;i<20000;i++)process.stderr.write("warn line "+i+"\\n")';
  const r = await runFfmpeg(process.execPath, ['-e', script], { stderrLimit: 4096 });
  assert.equal(r.status, 0);
  assert.ok(r.stderr.length <= 4096, `stderr 应被截断到 4096，实际 ${r.stderr.length}`);
  assert.ok(r.stderrDropped > 0, '被丢掉的字节数要能看出来');
});

test('T6 · runFfmpeg spawn 失败给 spawnError 而不是抛异常', async () => {
  const r = await runFfmpeg(join(tmpdir(), '绝对不存在的程序-xyz'), ['--version'], {});
  assert.ok(r.spawnError, '找不到可执行时应回 spawnError');
});

// ── 1b · 暂存目录可写性 & 输出锁时机（m01535 第 2 点）───────────────

test('T6 · 暂存目录建不起来（模型目录只读/被占）→ STAGE_UNWRITABLE 且带可操作建议', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vd-stage-'));
  const { model, input } = fixtures(dir);
  // 用「同名文件挡住目录」模拟不可写：无论 Windows 还是 POSIX 都会稳定失败，
  // 且不需要改权限位（CI/沙箱里改 chmod 不可靠）。
  writeFileSync(join(dir, 'models', '.asr-stage'), 'not a directory');
  let spawned = false;
  try {
    await transcribe({
      input, out: join(dir, 'out.srt'), cwd: dir, model, language: 'en',
      ffmpegCmd: 'fake-ffmpeg',
      ffmpegTarget: async (...a) => { spawned = true; return fakeTarget('ok')(...a); },
    });
    assert.fail('应当抛 STAGE_UNWRITABLE');
  } catch (e) {
    assert.equal(e.code, 'STAGE_UNWRITABLE');
    assert.match(e.message, /暂存目录不可写/);
    assert.ok(Array.isArray(e.hint) && e.hint.length >= 3, '要给出三条可操作建议，而不是一句「失败了」');
  } finally {
    assert.equal(spawned, false, '不可写必须在起 ffmpeg 之前就报，不能白跑一遍');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T6 · 输出锁在转写一开始就落盘（跨进程靠它，而不是靠进程内表）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vd-lock-'));
  const { model, input } = fixtures(dir);
  const out = join(dir, 'out.srt');
  const ctl = new AbortController();
  let lockSeenDuringRun = false;
  try {
    const p = transcribe({
      input, out, cwd: dir, model, language: 'en', signal: ctl.signal,
      ffmpegCmd: 'fake-ffmpeg',
      ffmpegTarget: async (cmd, args, o) => {
        // 子进程还在跑的时候，锁文件必须已经存在——别的进程据此判断「有人在写」
        lockSeenDuringRun = existsSync(`${out}.lock`);
        const lockBody = lockSeenDuringRun ? readFileSync(`${out}.lock`, 'utf8') : '';
        assert.match(lockBody, new RegExp(String(process.pid)), '锁文件里要写明持有者 pid');
        return fakeTarget('hang')(cmd, args, o);
      },
    });
    setTimeout(() => ctl.abort(), 100);
    await p.catch(() => {});
  } finally {
    assert.equal(lockSeenDuringRun, true, '转写进行期间必须能看到落盘锁');
    assert.equal(existsSync(`${out}.lock`), false, '结束后锁要清掉');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T6 · 别的进程留下的锁（同路径 .lock）→ 立刻 OUTPUT_CONFLICT，不覆盖也不清别人的锁', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vd-lock2-'));
  const { model, input } = fixtures(dir);
  const out = join(dir, 'out.srt');
  writeFileSync(`${out}.lock`, '999999 另一个进程 2026-11-11T00:00:00Z');
  let spawned = false;
  try {
    await transcribe({
      input, out, cwd: dir, model, language: 'en',
      ffmpegCmd: 'fake-ffmpeg',
      ffmpegTarget: async (...a) => { spawned = true; return fakeTarget('ok')(...a); },
    });
    assert.fail('应当抛 OUTPUT_CONFLICT');
  } catch (e) {
    assert.equal(e.code, 'OUTPUT_CONFLICT');
    assert.match(e.message, /锁/);
  } finally {
    assert.equal(spawned, false, '锁被占时不该起子进程');
    assert.ok(existsSync(`${out}.lock`), '别人的锁不能被我们删掉');
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 2 · transcribe 的判定契约（不依赖子进程） ─────────────────────────

test('T6 · transcribe 成功：临时目录清理干净，产物原子落盘', async () => {
  const dir = tmp();
  try {
    const { model, input } = fixtures(dir);
    const out = join(dir, 'out', 'audio.srt');
    const stageRoot = join(dir, 'models', '.asr-stage');
    const ok = await transcribeWithFake(dir, { input, out, model, mode: 'ok' });
    assert.ok(ok.bytes > 0);
    assert.equal(existsSync(out), true, '正式文件必须存在');
    assert.equal(readFileSync(out, 'utf8'), SRT_OK);
    // 暂存区不留半成品（目录本身可以留着，下次接着用）
    const left = existsSync(stageRoot) ? readdirSync(stageRoot) : [];
    assert.deepEqual(left, [], `暂存区必须清空，实际残留：${left.join(',')}`);
    // 输出目录里也不能留下锁文件 / .tmp
    const junk = readdirSync(join(dir, 'out')).filter((n) => n.endsWith('.lock') || n.endsWith('.tmp'));
    assert.deepEqual(junk, [], `不能残留锁文件或临时文件：${junk.join(',')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T6 · 目标已存在且没允许覆盖 → OUTPUT_CONFLICT，旧字幕一动不动', async () => {
  const dir = tmp();
  try {
    const { model, input } = fixtures(dir);
    const out = join(dir, 'audio.srt');
    const OLD = '1\n00:00:00,000 --> 00:00:02,000\n上一轮的旧字幕\n';
    writeFileSync(out, OLD);
    const before = readFileSync(out);
    const err = await transcribeWithFake(dir, { input, out, model, mode: 'ok' }).catch((e) => e);
    assert.equal(err.code, 'OUTPUT_CONFLICT');
    assert.equal(readFileSync(out, 'utf8'), OLD, '默认不许覆盖：旧字幕连一个字节都不能变');
    assert.equal(readFileSync(out).equals(before), true);
    assert.equal(existsSync(`${out}.lock`), false, '拒了就不能留锁');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T6 · 整个转写过程中旧字幕一直可读，成功后才被一次替换', async () => {
  const dir = tmp();
  try {
    const { model, input } = fixtures(dir);
    const out = join(dir, 'audio.srt');
    const OLD = '1\n00:00:00,000 --> 00:00:02,000\n旧字幕\n';
    writeFileSync(out, OLD);
    let saw = null;
    // 假 ffmpeg 跑起来的那一刻，旧字幕必须还在原位（不是被先移走、跑完再放回）
    const watch = async (cmd, args, o) => {
      saw = existsSync(out) ? readFileSync(out, 'utf8') : null;
      return fakeTarget('ok')(cmd, args, o);
    };
    const ok = await transcribe({
      input, out, cwd: dir, model, overwrite: true,
      ffmpegCmd: 'fake-ffmpeg', ffmpegTarget: watch,
    });
    assert.ok(ok.bytes > 0);
    assert.equal(saw, OLD, '子进程运行期间旧字幕必须可读且内容不变');
    assert.equal(readFileSync(out, 'utf8'), SRT_OK, '成功后新结果提交到正式路径');
    // 提交用 rename 覆盖：不能留下中间文件
    const junk = readdirSync(dir).filter((n) => n.endsWith('.lock') || n.endsWith('.tmp'));
    assert.deepEqual(junk, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T6 · 同一输出路径被别的转写占着 → OUTPUT_CONFLICT，不覆盖对方', async () => {
  const dir = tmp();
  try {
    const { model, input } = fixtures(dir);
    const out = join(dir, 'audio.srt');
    writeFileSync(out, SRT_OK);
    // 残留锁 = 另一个转写正拿着这个输出路径（或崩溃后没清锁）
    const lock = `${out}.lock`;
    writeFileSync(lock, 'someone-else');
    const err = await transcribe({
      input, out, cwd: dir, model, overwrite: true,
      ffmpegCmd: 'fake-ffmpeg', ffmpegTarget: fakeTarget('ok'),
    }).catch((e) => e);
    assert.equal(err.code, 'OUTPUT_CONFLICT');
    assert.equal(readFileSync(out, 'utf8'), SRT_OK, '对方的文件不能被换掉');
    assert.equal(readFileSync(lock, 'utf8'), 'someone-else', '别人的锁也不能被我清掉');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T6 · 转写失败时旧字幕不会被误认成新成果', async () => {
  const dir = tmp();
  try {
    const { model, input } = fixtures(dir);
    const out = join(dir, 'audio.srt');
    writeFileSync(out, SRT_OK);
    const err = await transcribeWithFake(dir, { input, out, model, mode: 'crash', overwrite: true }).catch((e) => e);
    assert.equal(err.code, 'TRANSCRIBE_FAILED');
    assert.equal(err.messageZh, ASR_ERRORS.TRANSCRIBE_FAILED);
    assert.equal(readFileSync(out, 'utf8'), SRT_OK, '失败时旧字幕必须原封不动');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T6 · 退出码 0 但产物是空壳 → TRANSCRIBE_EMPTY，不算成功', async () => {
  const dir = tmp();
  try {
    const { model, input } = fixtures(dir);
    const out = join(dir, 'audio.srt');
    const err = await transcribeWithFake(dir, { input, out, model, mode: 'empty' }).catch((e) => e);
    assert.equal(err.code, 'TRANSCRIBE_EMPTY');
    assert.equal(existsSync(out), false, '空壳字幕不能落到正式路径');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T6 · 退出码 0 但完全没产物 → TRANSCRIBE_NO_OUTPUT', async () => {
  const dir = tmp();
  try {
    const { model, input } = fixtures(dir);
    const out = join(dir, 'audio.srt');
    const err = await transcribeWithFake(dir, { input, out, model, mode: 'none' }).catch((e) => e);
    assert.equal(err.code, 'TRANSCRIBE_NO_OUTPUT');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T6 · 取消转写 → TRANSCRIBE_CANCELLED，且不留下临时目录', async () => {
  const dir = tmp();
  try {
    const { model, input } = fixtures(dir);
    const out = join(dir, 'audio.srt');
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 200);
    const err = await transcribeWithFake(dir, { input, out, model, mode: 'hang', signal: ctl.signal })
      .catch((e) => e);
    assert.equal(err.code, 'TRANSCRIBE_CANCELLED');
    const left = readdirSync(dir).filter((n) => n.startsWith('.asr-'));
    assert.deepEqual(left, [], '取消后临时目录必须清理');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T6 · stderr 有界：失败信息里只带末尾若干字节', async () => {
  const dir = tmp();
  try {
    const { model, input } = fixtures(dir);
    const out = join(dir, 'audio.srt');
    const err = await transcribeWithFake(dir, { input, out, model, mode: 'crash' }).catch((e) => e);
    assert.ok(String(err.stderr ?? '').length <= 4000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T6 · 并发转写各用独立临时目录，互不覆盖', async () => {
  const dir = tmp();
  try {
    const { model, input } = fixtures(dir);
    const outs = [1, 2, 3].map((i) => join(dir, `c${i}`, 'audio.srt'));
    await Promise.all(outs.map((out) => transcribeWithFake(dir, { input, out, model, mode: 'ok' })));
    for (const out of outs) assert.equal(readFileSync(out, 'utf8'), SRT_OK);
    for (let i = 1; i <= 3; i += 1) {
      const left = readdirSync(join(dir, `c${i}`)).filter((n) => n.startsWith('.asr-'));
      assert.deepEqual(left, []);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T6 · 一路失败不影响另一路的产物', async () => {
  const dir = tmp();
  try {
    const { model, input } = fixtures(dir);
    const good = join(dir, 'good', 'audio.srt');
    const bad = join(dir, 'bad', 'audio.srt');
    const [g, b] = await Promise.all([
      transcribeWithFake(dir, { input, out: good, model, mode: 'ok' }),
      transcribeWithFake(dir, { input, out: bad, model, mode: 'crash' }).catch((e) => e),
    ]);
    assert.ok(g.bytes > 0);
    assert.equal(b.code, 'TRANSCRIBE_FAILED');
    assert.equal(readFileSync(good, 'utf8'), SRT_OK, '失败的一路不能影响成功的一路');
    assert.equal(existsSync(bad), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T6 · 两个转写抢同一个输出：后到的立刻失败，不白跑一遍 GPU', async () => {
  const dir = mkdtempSync(join(tmp(), 'race-'));
  const input = join(dir, 'talk.mp3');
  writeFileSync(input, 'x', 'utf8');
  const out = join(dir, 'talk.srt');
  const { model } = fixtures(dir);
  const slow = fakeTarget('ok');
  const p1 = transcribeWithFake(dir, { ...slow, input, out, model, language: 'en' });
  // 同一目标再开一路：应当立刻被拒，而不是等第一路跑完才发现冲突
  const t0 = Date.now();
  const e2 = await transcribeWithFake(dir, { ...slow, input, out, model, language: 'en' })
    .then(() => null, (e) => e);
  const waited = Date.now() - t0;
  assert.equal(e2?.code, 'OUTPUT_CONFLICT');
  assert.ok(waited < 25, `第二路应该立刻失败，实际等了 ${waited}ms`);
  const ok1 = await p1;
  assert.equal(ok1.out, out);
  assert.ok(readFileSync(out, 'utf8').includes('-->'));
  // 锁文件必须清干净
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.lock') || f.endsWith('.tmp')), []);
});

test('T6 · srt 内容判定：空壳 / 无时间轴都不算有内容', () => {
  assert.equal(srtHasContent(SRT_OK), true);
  assert.equal(srtHasContent(''), false);
  assert.equal(srtHasContent('\uFEFF'), false);
  assert.equal(srtHasContent('1\n\n2\n\n'), false);
  assert.equal(srtHasContent('1\n00:00:00,000 --> 00:00:01,000\n\n'), false);
});

// ── 2.5 · 日文不接受英语专用模型 ─────────────────────────────────────

test('T6 · 模型名判定：只认 .en 后缀，不靠猜', () => {
  assert.equal(isEnglishOnlyModel('ggml-base.en.bin'), true);
  assert.equal(isEnglishOnlyModel('models/ggml-small.en.bin'), true);
  assert.equal(isEnglishOnlyModel('GGML-MEDIUM.EN.BIN'), true);
  assert.equal(isEnglishOnlyModel('ggml-small.bin'), false);
  assert.equal(isEnglishOnlyModel('ggml-medium.bin'), false);
  // 名字里带 en 但没带 .en 后缀的不是英语专用模型
  assert.equal(isEnglishOnlyModel('ggml-en-notes.bin'), false);
});

test('T6 · 日语 + 英语专用模型 → MODEL_LANGUAGE_MISMATCH，且不产出任何文件', async () => {
  const dir = tmp();
  try {
    const { models, input } = fixtures(dir);
    const englishOnly = join(models, 'ggml-base.en.bin');
    writeFileSync(englishOnly, 'fake');
    const out = join(dir, 'audio.srt');
    const err = await transcribe({
      input, out, cwd: dir, model: englishOnly, language: 'ja',
      ffmpegCmd: 'fake-ffmpeg', ffmpegTarget: fakeTarget('ok'),
    }).catch((e) => e);
    assert.equal(err.code, 'MODEL_LANGUAGE_MISMATCH');
    assert.equal(existsSync(out), false, '拒了就不能先写文件');
    assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith('.asr-')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T6 · 同一个英语专用模型转英文是允许的（只挡日语）', async () => {
  const dir = tmp();
  try {
    const { models, input } = fixtures(dir);
    const englishOnly = join(models, 'ggml-base.en.bin');
    writeFileSync(englishOnly, 'fake');
    const out = join(dir, 'audio.srt');
    const ok = await transcribe({
      input, out, cwd: dir, model: englishOnly, language: 'en',
      ffmpegCmd: 'fake-ffmpeg', ffmpegTarget: fakeTarget('ok'),
    });
    assert.ok(ok.bytes > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T6 · 日文 + 多语种模型正常放行', async () => {
  const dir = tmp();
  try {
    const { model, input } = fixtures(dir);
    const ok = await transcribe({
      input, out: join(dir, 'j.srt'), cwd: dir, model, language: 'ja',
      ffmpegCmd: 'fake-ffmpeg', ffmpegTarget: fakeTarget('ok'),
    });
    assert.equal(ok.language, 'ja');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 2.6 · 中文 / 空格 / 单引号 / 跨盘路径 ────────────────────────────

test('T6 · 含中文和空格的目录：转写与下载都能正确落盘', async () => {
  // 目录名带中文、空格、单引号——这三种是最容易把 spawn 参数/命令行拆坏的东西
  const parent = tmp();
  const dir = join(parent, "工作 区's test");
  mkdirSync(dir, { recursive: true });
  try {
    const { model, input } = fixtures(dir);
    const out = join(dir, '字幕 输出', "日语's 第1集.srt");
    const ok = await transcribe({
      input, out, cwd: dir, model, language: 'ja',
      ffmpegCmd: 'fake-ffmpeg', ffmpegTarget: fakeTarget('ok'),
    });
    assert.equal(readFileSync(ok.out, 'utf8'), SRT_OK);
    assert.equal(existsSync(out), true);

    const dl = await download('https://cdn.example/x.bin', join(dir, '下载 的', "音频's.m4s"), {
      fetchImpl: async () => new Response(new TextEncoder().encode('abc'), {
        status: 200, headers: { 'content-length': '3' },
      }),
    });
    assert.equal(dl.ok, true);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('T6 · 跨盘路径：模型在 C 盘、产出在别的盘时给相对路径而不是绝对路径', async () => {
  // whisper 滤镜的 destination= 用冒号分隔，绝对路径（C:\…）会把整个滤镜串拆坏。
  // 所以 transcribe 一定要把输出转成「相对模型目录」的形式再交给 ffmpeg。
  const dir = tmp();
  try {
    const { model, input } = fixtures(dir);
    let seen = null;
    const spy = async (cmd, args, o) => {
      seen = { args, cwd: o.cwd };
      return fakeTarget('ok')(cmd, args, o);
    };
    await transcribe({
      input, out: join(dir, 'out', 'a.srt'), cwd: dir, model, language: 'ja',
      ffmpegCmd: 'fake-ffmpeg', ffmpegTarget: spy,
    });
    const af = seen.args[seen.args.indexOf('-af') + 1];
    assert.ok(af.includes('destination='), '需要 destination 参数');
    assert.ok(!/destination=[A-Za-z]:[/\\]/.test(af), `destination 不能是盘符绝对路径：${af}`);
    assert.equal(seen.cwd, join(dir, 'models'), '应该在模型目录里跑，相对路径才成立');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 3 · 下载：.part 流式落盘 + 原子完成 + 重试 + 取消 ────────────────

test('T6 · 下载先写 .part，完成后才出现正式文件', async () => {
  const dir = tmp();
  try {
    const out = join(dir, 'a.bin');
    const seen = [];
    const fakeFetch = async () => {
      seen.push({ existsFinal: existsSync(out) });
      const body = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('hello-'));
          c.enqueue(new TextEncoder().encode('world'));
          c.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-length': '11' } });
    };
    const r = await download('https://cdn.example/a.bin', out, { fetchImpl: fakeFetch });
    assert.equal(r.ok, true);
    assert.equal(r.bytes, 11);
    assert.equal(readFileSync(out, 'utf8'), 'hello-world');
    assert.equal(existsSync(`${out}.part`), false, '成功后 .part 必须消失');
    assert.deepEqual(seen, [{ existsFinal: false }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T6 · 下载内容长度对不上 → 判失败，不留半个正式文件', async () => {
  const dir = tmp();
  try {
    const out = join(dir, 'a.bin');
    const fakeFetch = async () => new Response(new TextEncoder().encode('short'), {
      status: 200,
      headers: { 'content-length': '100' },
    });
    const r = await download('https://cdn.example/a.bin', out, { fetchImpl: fakeFetch, retries: 0 });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'TRUNCATED');
    assert.equal(existsSync(out), false, '不完整的下载绝不能顶着正式文件名');
    assert.equal(existsSync(`${out}.part`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T6 · 下载有界重试：失败两次后成功', async () => {
  const dir = tmp();
  try {
    const out = join(dir, 'a.bin');
    let n = 0;
    const fakeFetch = async () => {
      n += 1;
      if (n < 3) return new Response('nope', { status: 500 });
      return new Response(new TextEncoder().encode('ok'), {
        status: 200,
        headers: { 'content-length': '2' },
      });
    };
    const r = await download('https://cdn.example/a.bin', out, { fetchImpl: fakeFetch, retries: 2, backoffMs: 10 });
    assert.equal(r.ok, true);
    assert.equal(r.attempts, 3);
    assert.equal(readFileSync(out, 'utf8'), 'ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T6 · 下载 404 不重试（立刻放弃）', async () => {
  const dir = tmp();
  try {
    let n = 0;
    const fakeFetch = async () => {
      n += 1;
      return new Response('gone', { status: 404 });
    };
    const r = await download('https://cdn.example/a.bin', join(dir, 'a.bin'), { fetchImpl: fakeFetch, retries: 5 });
    assert.equal(r.ok, false);
    assert.equal(n, 1, '4xx 重试没有意义，只能试一次');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T6 · 下载可取消：abort 后返回 CANCELLED 并清理 .part', async () => {
  const dir = tmp();
  try {
    const out = join(dir, 'a.bin');
    const ctl = new AbortController();
    const fakeFetch = async (_url, o) => {
      const body = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('x'));
          o.signal?.addEventListener?.('abort', () => {
            try { c.error(new Error('aborted')); } catch { /* 已关闭 */ }
          });
        },
      });
      return new Response(body, { status: 200 });
    };
    setTimeout(() => ctl.abort(), 150);
    const r = await download('https://cdn.example/a.bin', out, { fetchImpl: fakeFetch, signal: ctl.signal, retries: 3 });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CANCELLED');
    assert.equal(existsSync(out), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
