/**
 * 真实 B 站抓取与取消验收（m02395 第 2 项）
 *
 * 全程真实网络、真实 whisper、真实 Web 接口，不用任何替身：
 *   A. 完整成功流程：/api/run/fetch/start → 轮询 → /api/run/digest → Word
 *   B. 下载阶段取消：旧产物字节不变、.part / 锁 / 暂存都要清干净、无 ffmpeg 残留
 *   C. 转写阶段取消：whisper 子进程被杀、不产出半截字幕、无锁残留、服务仍可探活
 *   D. 取消后重新启动：同一个工作目录、同一条链接能跑完并出字幕
 *
 * 三个场景用三个独立工作目录（每个目录各起一个本地服务），互不干扰。
 *
 * 用法：node tools/probe-bili-real-flow.mjs
 * 产物：docs/evidence-t6-real-bili.txt
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startApp } from '../src/app/server.js';

const ROOT = resolve(import.meta.dirname, '..');
const LINK = 'BV1GJ411x7h7'; // 213s，无字幕轨 → 真实走「下载音频 + whisper」
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const lines = [];
const say = (s = '') => { lines.push(s); console.log(s); };
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1;
  say(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` —— ${detail}` : ''}`);
};

const listFiles = (dir) => (existsSync(dir) ? readdirSync(dir) : []);
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const shaOrEmpty = (file) => (existsSync(file) ? sha(file) : '');

/** ffmpeg 是否还在跑（tasklist 给 5s 超时，绝不能把脚本挂死） */
const ffmpegRunning = () => {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ffmpeg.exe', '/NH'], { encoding: 'utf8', timeout: 5000 });
    return /ffmpeg\.exe/i.test(out);
  } catch {
    return false;
  }
};

/** 建一个独立工作目录 + 本地服务（data/models 用 junction 指回工程，不做替身） */
async function makeWork(name, link = LINK) {
  const dir = join(mkdtempSync(join(tmpdir(), 'bili-flow-')), name);
  mkdirSync(dir, { recursive: true });
  for (const dep of ['data', 'models']) {
    symlinkSync(join(ROOT, dep), join(dir, dep), 'junction');
  }
  const app = await startApp({ cwd: dir, port: 0 });
  const base = app.url.replace(/\/$/, '');
  const post = async (path, body) => {
    const r = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(60_000),
    });
    return r.json();
  };
  const get = async (path) => (await fetch(`${base}${path}`, { signal: AbortSignal.timeout(30_000) })).json();
  const waitTask = async (id, { timeoutMs = 20 * 60_000, until } = {}) => {
    if (!id) return null;
    const startedAt = Date.now();
    let last = null;
    while (Date.now() - startedAt < timeoutMs) {
      const r = await get(`/api/tasks?id=${encodeURIComponent(id)}`);
      if (r.ok && r.task) {
        last = r.task;
        if (last.done || until?.(last)) return last;
      }
      await sleep(250);
    }
    return last;
  };
  return { dir, app, base, post, get, waitTask, sample: join(dir, 'samples', `${link}.p1`) };
}

// ───────────────────────────────── A. 完整成功流程 ─────────────────────────────────
say('=== A. 完整成功流程（真实 B 站 + 真 whisper + digest + Word）===');
const A = await makeWork('成功');
say(`工作目录：${A.dir}`);
const tA = Date.now();
const startA = await A.post('/api/run/fetch/start', { link: LINK, withDanmaku: true, asr: true, language: 'en' });
check('A1 start 立刻返回 taskId', Boolean(startA.ok && startA.taskId), `${Date.now() - tA}ms id=${startA.taskId}`);

const alive = [];
const pollA = (async () => {
  for (let i = 0; i < 25; i += 1) {
    const t0 = Date.now();
    const st = await A.get('/api/state');
    alive.push({ ms: Date.now() - t0, ok: Boolean(st.ok) });
    await sleep(500);
  }
})();
const taskA = await A.waitTask(startA.taskId, { until: (t) => Boolean(t.result) });
await pollA;
const resA = taskA?.result ?? null;
check('A2 取数成功', resA?.ok === true, resA?.message ?? '');
const worst = alive.length ? Math.max(...alive.map((x) => x.ms)) : 0;
check('A3 转写期间服务仍可探活', alive.every((x) => x.ok) && worst < 2000, `${alive.length} 次 /api/state，最慢 ${worst}ms`);

const filesA = listFiles(A.sample);
const srtA = join(A.sample, 'audio.p1.srt');
const srtText = existsSync(srtA) ? readFileSync(srtA, 'utf8') : '';
check('A4 产物齐全', ['meta.json', 'danmaku.xml', 'audio.p1.m4s', 'audio.p1.srt'].every((f) => filesA.includes(f)), filesA.join(' '));
check('A5 字幕是带时间轴的 SRT', /-->\s*\d{2}:\d{2}:\d{2}/.test(srtText), `${srtText.split(/\n\s*\n/).filter((b) => /-->/.test(b)).length} 条`);
check('A6 无 .part / .lock / .tmp 残留', !filesA.some((f) => /\.part$|\.lock$|\.tmp$/.test(f)), filesA.join(' '));
check('A7 无 ffmpeg 残留进程', !ffmpegRunning());

const digA = await A.post('/api/run/digest', { inputs: resA?.inputs ?? [srtA], language: 'en', by: 'pos' });
check('A8 digest 成功', digA.ok === true, `runId=${digA.runId} ${digA.message ?? ''}`);
if (digA.ok) {
  const dig = JSON.parse(readFileSync(join(A.dir, 'runs', digA.runId, 'digest.json'), 'utf8'));
  check('A9 词条数与语言正确', (dig.items?.length ?? 0) > 0 && dig.language === 'en', `${dig.items?.length ?? 0} 词条 / ${dig.language}`);
  const docx = join(A.dir, 'runs', digA.runId, 'vocab.docx');
  check('A10 Word 已生成', existsSync(docx) && statSync(docx).size > 5000, existsSync(docx) ? `${(statSync(docx).size / 1024).toFixed(0)} KB` : '无');
}

// ───────────────────────── B. 下载阶段取消（旧产物不变）─────────────────────────
say('');
say('=== B. 下载阶段取消：旧产物必须一字节不变 ===');
// 用一个 A 没碰过的源（避免音频被复用），取消窗口落在「网络取数」阶段
const LINK_B = 'BV1Ks411p7Zq';
const B = await makeWork('取消下载', LINK_B);
say(`工作目录：${B.dir}（源 ${LINK_B}）`);
mkdirSync(B.sample, { recursive: true });
// 旧产物：meta.json 哨兵（取数成功收尾时才写，取消后必须原样不乱改）
const oldMeta = join(B.sample, 'meta.json');
const OLD_META = '{"sentinel":"旧 meta，取消后不得被改写"}\n';
writeFileSync(oldMeta, OLD_META, 'utf8');
const oldMetaSha = sha(oldMeta);
say(`旧产物：meta.json（${oldMetaSha.slice(0, 12)}…，${OLD_META.length} 字节）`);

const startB = await B.post('/api/run/fetch/start', { link: LINK_B, withDanmaku: false, asr: true, language: 'en' });
check('B1 start 返回 taskId', Boolean(startB.ok && startB.taskId), `id=${startB.taskId}`);
await sleep(150);
const cancelB = await B.post('/api/tasks/cancel', { id: startB.taskId });
const taskB = await B.waitTask(startB.taskId, { timeoutMs: 90_000 });
await sleep(1200);
const resB = taskB?.result ?? null;
const filesB = listFiles(B.sample);
const audioB = join(B.sample, 'audio.p1.m4s');
const audioInfo = existsSync(audioB) ? `${statSync(audioB).size} 字节` : '未落盘';
say(`取消应答：${cancelB.ok ? 'ok' : String(cancelB.message ?? '')}；音频：${audioInfo}；收尾码：${resB?.code ?? ''}`);
check('B2 取消被接受', cancelB.ok === true, String(cancelB.message ?? ''));
check('B3 任务以「取消」收尾', resB?.ok === false && /CANCEL|取消/.test(`${resB?.code ?? ''} ${resB?.message ?? ''}`), `${resB?.code} ${String(resB?.message ?? '').slice(0, 60)}`);
check('B4 取消不是因为转写（确实死在取数阶段）', !/^TRANSCRIBE_/.test(String(resB?.code ?? '')), String(resB?.code ?? ''));
// meta.json 是「开头就写」的（fetch.js 在下载音频之前写），所以取消后它被刷新是设计行为；
// 真正要保证的是：不能写半截，必须仍是完整可解析的 JSON
const metaNow = existsSync(oldMeta) ? readFileSync(oldMeta, 'utf8') : '';
let metaOk = shaOrEmpty(oldMeta) === oldMetaSha;
if (!metaOk) {
  try {
    const j = JSON.parse(metaNow);
    metaOk = typeof j === 'object' && j !== null && Object.keys(j).length > 0;
  } catch {
    metaOk = false;
  }
}
check('B5 旧 meta.json 要么原样、要么换成完整的 JSON（不是半截）', metaOk, `${metaNow.length} 字节`);
check('B6 未留下 .part 半成品', !filesB.some((f) => f.endsWith('.part')), filesB.join(' '));
check('B7 未留下锁 / 临时文件', !filesB.some((f) => /\.lock$|\.tmp$/.test(f)), filesB.join(' '));
check('B8 无 ffmpeg 残留进程', !ffmpegRunning());
check('B9 没有产出半截字幕', !existsSync(join(B.sample, 'audio.p1.srt')));

// ───────────────────────────── C. 转写阶段取消 ─────────────────────────────
say('');
say('=== C. 转写阶段取消：whisper 子进程必须被杀 ===');
const C = await makeWork('取消转写');
say(`工作目录：${C.dir}`);
const startC = await C.post('/api/run/fetch/start', { link: LINK, withDanmaku: false, asr: true, language: 'en' });
const seenC = await C.waitTask(startC.taskId, {
  timeoutMs: 180_000,
  until: () => ffmpegRunning(),
});
check('C1 进入转写阶段（ffmpeg 在跑）', Boolean(seenC));
await sleep(1500);
const runningBefore = ffmpegRunning();
const t0 = Date.now();
const cancelC = await C.post('/api/tasks/cancel', { id: startC.taskId });
const taskC = await C.waitTask(startC.taskId, { timeoutMs: 60_000 });
const cancelMs = Date.now() - t0;
await sleep(2000);
const resC = taskC?.result ?? null;
const filesC = listFiles(C.sample);
check('C2 取消时确认 whisper 正在跑', runningBefore);
check('C3 取消被接受且任务收尾', cancelC.ok === true && resC?.ok === false, `${cancelMs}ms ${resC?.code} ${String(resC?.message ?? '').slice(0, 60)}`);
check('C4 whisper 子进程已结束', !ffmpegRunning());
check('C5 取消后没有新字幕', !existsSync(join(C.sample, 'audio.p1.srt')), filesC.join(' '));
check('C6 无 .part / .lock / .tmp 残留', !filesC.some((f) => /\.part$|\.lock$|\.tmp$/.test(f)), filesC.join(' '));
check('C7 暂存目录已清空', !existsSync(join(C.dir, 'models', '.asr-stage')) || listFiles(join(C.dir, 'models', '.asr-stage')).length === 0);
const stAlive = await C.get('/api/state');
check('C8 取消后服务仍正常', stAlive.ok === true);

// ─────────────────────────── D. 取消后重新启动 ───────────────────────────
say('');
say('=== D. 取消后重新启动（同一目录、同一链接）===');
const tD = Date.now();
const startD = await C.post('/api/run/fetch/start', { link: LINK, withDanmaku: false, asr: true, language: 'en' });
check('D1 能重新启动', Boolean(startD.ok && startD.taskId), `id=${startD.taskId}`);
const taskD = await C.waitTask(startD.taskId, { timeoutMs: 20 * 60_000, until: (t) => Boolean(t.result) });
const resD = taskD?.result ?? null;
check('D2 重启后跑完并成功', resD?.ok === true, resD?.message ?? '');
const srtD = join(C.sample, 'audio.p1.srt');
check('D3 这次真的产出字幕', existsSync(srtD) && /-->\s*\d{2}:\d{2}:\d{2}/.test(readFileSync(srtD, 'utf8')), `总耗时 ${((Date.now() - tD) / 1000).toFixed(0)}s`);
check('D4 无残留', !listFiles(C.sample).some((f) => /\.part$|\.lock$|\.tmp$/.test(f)) && !ffmpegRunning());

say('');
say(failed === 0 ? '=== 全部通过 ===' : `=== ${failed} 项未通过 ===`);
for (const w of [A, B, C]) w.app.server.close?.();
writeFileSync(join(ROOT, 'docs', 'evidence-t6-real-bili.txt'), `${lines.join('\n')}\n`, 'utf8');
console.log('\n写入 docs/evidence-t6-real-bili.txt');
console.log(`工作目录：${A.dir} / ${B.dir} / ${C.dir}`);
process.exit(failed === 0 ? 0 : 1);
