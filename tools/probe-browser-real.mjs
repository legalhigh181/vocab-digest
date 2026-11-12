/**
 * 真实浏览器验收（T6 待验收项「真实浏览器」）
 *
 * 前面的 tools/probe-browser.mjs 用自制 DOM 垫片跑 app.js，只能证明逻辑，
 * 不能证明「真的浏览器里能渲染、点了能出内容」。这里换真的：
 *
 *   Edge(--headless=new) + CDP(Runtime.evaluate / Page.captureScreenshot)
 *
 * 做四件事：
 *   1. 起本地服务（startApp），页面真加载；
 *   2. 点「日语」运行 → 断言徽标=JA、词条卡有片假名读音、没有英文音标；
 *   3. 点「英语」运行 → 断言有音标（证明两种语言不串）；
 *   4. 截图存档，供人工看。
 *
 * 用法：node tools/probe-browser-real.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startApp } from '../src/app/server.js';
import { runDigestAsync } from '../src/run.js';

const ROOT = resolve(import.meta.dirname, '..');
const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => existsSync(p));

const lines = [];
const say = (s) => { lines.push(s); console.log(s); };
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail });
  say(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 起 headless 浏览器，返回 {wsUrl(浏览器级), close}
 *
 * 注意：Chromium 的启动器进程常常「起来就退」，真正的浏览器在子进程里。
 * 所以不能靠读父进程 stderr 拿「DevTools listening on」，只能：
 *   1. 自己挑一个空闲端口；
 *   2. 轮询 http://127.0.0.1:<port>/json/version 直到浏览器应答。
 */
async function launchBrowser() {
  const port = await new Promise((res) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
  const profile = mkdtempSync(join(tmpdir(), 'edge-prof-'));
  const proc = spawn(EDGE, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    '--window-size=1440,2000',
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  proc.on('error', () => { /* 启动器退出无所谓，下面靠 HTTP 判活 */ });

  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) {
        const v = await r.json();
        return {
          wsUrl: v.webSocketDebuggerUrl,
          port,
          close: async () => {
            try {
              const b = await cdp(v.webSocketDebuggerUrl);
              await b.send('Browser.close');
              b.close();
            } catch { /* 已退出 */ }
            try { proc.kill('SIGKILL'); } catch { /* parent 早就退了 */ }
            await sleep(500);
            rmSync(profile, { recursive: true, force: true });
          },
        };
      }
    } catch { /* 还没起来 */ }
    await sleep(300);
  }
  throw new Error(`浏览器 25s 没应答调试端口 ${port}`);
}

/** 极简 CDP 客户端（Node 22+ 有全局 WebSocket） */
async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error(`WS 连不上：${e?.message ?? ''}`)); });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  /** 在页面里求值，返回值直接给出来 */
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(`页面报错：${r.result.exceptionDetails.text} ${r.result.exceptionDetails.exception?.description ?? ''}`);
    return r.result?.result?.value;
  };
  return { send, evaluate, close: () => { try { ws.close(); } catch { /* ignore */ } } };
}

async function main() {
  if (!EDGE) {
    say('没找到 Edge/Chrome，真实浏览器验收无法进行（记为待验收）');
    process.exit(0);
  }
  say(`浏览器：${EDGE}`);

  // 造两个运行：一个日语、一个英语（runId 唯一，跑完删掉）
  const stamp = `${process.pid}-${Date.now().toString(36)}`;
  const jaRun = `probe-ui-ja-${stamp}`;
  const enRun = `probe-ui-en-${stamp}`;
  await runDigestAsync({ inputs: [join(ROOT, 'samples/ja/demo.srt')], cwd: ROOT, runId: jaRun, language: 'ja' });
  await runDigestAsync({ inputs: [join(ROOT, 'test/fixtures/lecture.srt')], cwd: ROOT, runId: enRun, language: 'en' });
  say(`造好两个运行：${jaRun} / ${enRun}`);

  const app = await startApp({ cwd: ROOT, port: 0 });
  say(`服务：${app.url}`);

  const browser = await launchBrowser();
  let client;
  try {
    // 页面目标：从浏览器的 /json/list 里找第一个 page
    const targets = await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json();
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('浏览器里没有 page 目标');
    client = await cdp(page.webSocketDebuggerUrl);
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 2000, deviceScaleFactor: 1, mobile: false });
    await client.send('Page.navigate', { url: app.url });

    // 等 JS 把运行列表画出来（真 fetch + 真渲染）
    const waitFor = async (expr, ms = 15000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        try { if (await client.evaluate(expr)) return true; } catch { /* 页面还没起来 */ }
        await sleep(200);
      }
      return false;
    };
    const runsReady = await waitFor("document.querySelectorAll('#runs .run').length >= 2");
    check('页面加载后运行列表由 JS 填充', runsReady, await client.evaluate("document.querySelectorAll('#runs .run').length + ' 个运行'"));

    const uiStatic = await client.evaluate(`JSON.stringify({
      langSel: [...document.querySelectorAll('#langSel option')].map(o => o.value).join(','),
      newListLang: [...document.querySelectorAll('#newListLang option')].map(o => o.value).join(','),
      viewLang: [...document.querySelectorAll('#viewLang option')].map(o => o.value).join(','),
      title: (document.getElementById('title') || {}).textContent || '',
    })`);
    const ui = JSON.parse(uiStatic);
    check('页面上有语言选择入口（抓取/新表/界面）', ui.langSel === 'en,ja' && ui.newListLang === 'en,ja' && ui.viewLang === 'en,ja', JSON.stringify(ui));

    // 日语 + 勾了语音识别 → 「识别质量有限」提醒必须在点抓取之前就看得见
    const noteTab = JSON.parse(await client.evaluate(`(() => {
      const sel = document.getElementById('langSel');
      const asr = document.getElementById('asr');
      const note = document.getElementById('jaAsrNote');
      if (asr) { asr.checked = true; asr.dispatchEvent(new Event('change')); }
      sel.value = 'ja'; sel.dispatchEvent(new Event('change'));
      const shownJa = note && !note.hidden && /幻觉|听错/.test(note.textContent);
      sel.value = 'en'; sel.dispatchEvent(new Event('change'));
      const hiddenEn = note && note.hidden;
      return JSON.stringify({ shownJa: Boolean(shownJa), hiddenEn: Boolean(hiddenEn) });
    })()`));
    check('日语+语音识别时显示「识别质量有限」提醒', noteTab.shownJa);
    check('切回英语后提醒自动收起', noteTab.hiddenEn);

    // 点日语运行
    const clickedJa = await client.evaluate(`(() => {
      const rs = [...document.querySelectorAll('#runs .run')];
      const t = rs.find(e => /日语/.test(e.textContent));
      if (!t) return 'no-ja-run';
      t.click();
      return 'clicked';
    })()`);
    check('能点开日语运行', clickedJa === 'clicked', clickedJa);

    const itemsReady = await waitFor("document.querySelectorAll('#items .item').length > 0");
    check('日语词条卡渲染出来了', itemsReady, await client.evaluate("document.querySelectorAll('#items .item').length + ' 张卡'"));

    const jaView = JSON.parse(await client.evaluate(`JSON.stringify({
      badge: (document.querySelector('#langBadge') || {}).textContent || '',
      badgeHidden: Boolean((document.querySelector('#langBadge') || {}).hidden),
      readings: [...document.querySelectorAll('#items .item .reading')].map(e => e.textContent).slice(0, 6),
      phon: document.querySelectorAll('#items .item .phon').length,
      kana: [...document.querySelectorAll('#items .item .reading .kata')].map(e => e.textContent).slice(0, 6),
      stats: (document.getElementById('stats') || {}).textContent || '',
      subtitle: (document.getElementById('subtitle') || {}).textContent || '',
    })`));
    check('中栏显示日语徽标', !jaView.badgeHidden && /JA/i.test(jaView.badge), `badge=${jaView.badge}`);
    check('日语词条卡有片假名读音', jaView.kana.length > 0, `kata=${jaView.kana.join(' | ')}`);
    check('日语运行不显示英文音标', jaView.phon === 0, `.phon 节点 ${jaView.phon} 个`);
    check('日语的读音出现在卡片上', jaView.readings.some((t) => /[ァ-ヶー]/.test(t)), jaView.readings.join(' | '));
    say(`统计行：${jaView.stats}`);
    say(`副标题：${jaView.subtitle}`);

    // 截图（日语视图）
    const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const pngPath = join(ROOT, 'docs', 'evidence-browser-ja.png');
    writeFileSync(pngPath, Buffer.from(shot.result.data, 'base64'));
    check('截图已保存', existsSync(pngPath), `${pngPath}（${Math.round(readFileSync(pngPath).length / 1024)} KB）`);

    // 再点英语运行，确认不串
    const clickedEn = await client.evaluate(`(() => {
      const rs = [...document.querySelectorAll('#runs .run')];
      const t = rs.find(e => !/日语/.test(e.textContent));
      if (!t) return 'no-en-run';
      t.click();
      return 'clicked';
    })()`);
    check('能点开英语运行', clickedEn === 'clicked', clickedEn);
    await waitFor("document.querySelectorAll('#items .item').length > 0");
    await sleep(300);
    const enView = JSON.parse(await client.evaluate(`JSON.stringify({
      badge: (document.querySelector('#langBadge') || {}).textContent || '',
      badgeHidden: Boolean((document.querySelector('#langBadge') || {}).hidden),
      phon: document.querySelectorAll('#items .item .phon').length,
      readings: document.querySelectorAll('#items .item .reading').length,
    })`));
    check('切到英语后徽标变 EN', !enView.badgeHidden && /EN/i.test(enView.badge), `badge=${enView.badge}`);
    check('英语词条有音标、没有日语读音行', enView.phon > 0 && enView.readings === 0, `.phon=${enView.phon} .reading=${enView.readings}`);

    const shot2 = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(join(ROOT, 'docs', 'evidence-browser-en.png'), Buffer.from(shot2.result.data, 'base64'));
  } finally {
    try { client?.close(); } catch { /* ignore */ }
    await browser.close();
    await new Promise((res) => app.server.close(res));
    rmSync(join(ROOT, 'runs', jaRun), { recursive: true, force: true });
    rmSync(join(ROOT, 'runs', enRun), { recursive: true, force: true });
  }

  const pass = results.filter((r) => r.ok).length;
  say(`\n合计 ${results.length} 项，通过 ${pass} 项，失败 ${results.length - pass} 项`);
  writeFileSync(join(ROOT, 'docs', 'evidence-browser-real.txt'), `${lines.join('\n')}\n`, 'utf8');
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

main().catch((e) => {
  say(`探针崩了：${e.stack ?? e.message}`);
  writeFileSync(join(ROOT, 'docs', 'evidence-browser-real.txt'), `${lines.join('\n')}\n`, 'utf8');
  process.exit(1);
});
