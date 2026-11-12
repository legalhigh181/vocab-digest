/**
 * 用「借来的登录态」查 B 站视频到底有没有字幕轨。
 *
 * 为什么不在 Node 里直接请求：字幕列表接口要 WBI 签名 + 登录 cookie，
 * 在页面里用 credentials:'include' 让浏览器自己带 cookie 最省事。
 *
 * 用法：
 *   node tools/probe-bili-subtitle-login.mjs BV1GJ411x7h7 BV1H64y1e7YJ
 *   node tools/probe-bili-subtitle-login.mjs --profile "%TEMP%\edge-bili-profile"
 *
 * 只读：只导航、只读 DOM / 播放器状态，不点登录、不改任何账号设置。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const args = process.argv.slice(2);
const profileIdx = args.indexOf('--profile');
const profile = profileIdx >= 0 ? args.splice(profileIdx, 2)[1] : join(process.env.TEMP ?? '.', 'edge-bili-profile');
const bvs = args.filter((a) => /^BV[0-9A-Za-z]{10}$/.test(a));
const VIDEOS = bvs.length ? bvs : ['BV1GJ411x7h7', 'BV1H64y1e7YJ', 'BV1Ks411p7Zq', 'BV1xx411c7mD'];

const say = (s = '') => console.log(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

/** 极简 CDP 客户端：够用就行，不引第三方包 */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.waiting = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      const w = this.waiting.get(msg.id);
      if (!w) return;
      this.waiting.delete(msg.id);
      if (msg.error) w.reject(new Error(msg.error.message));
      else w.resolve(msg.result);
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.waiting.delete(id)) reject(new Error(`CDP 超时：${method}`));
      }, 30_000);
    });
  }

  async evaluate(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? '页面里执行出错');
    return r.result?.value;
  }
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('连不上 CDP')), { once: true });
  });
  return new Cdp(ws);
}

async function pageTarget(port) {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  return '';
}

if (!existsSync(EDGE)) {
  say(`找不到 Edge：${EDGE}`);
  process.exit(2);
}
if (!existsSync(join(profile, 'Default', 'Network', 'Cookies'))) {
  say(`这个 profile 里没有 cookie 库：${profile}`);
  say('先复制一份带登录态的 profile（Edge 必须完全退出）。');
  process.exit(2);
}

const port = await freePort();
const edge = spawn(
  EDGE,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=msEdgeIdentityFRE,msEdgeSyncFRE',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    'about:blank',
  ],
  { stdio: 'ignore', windowsHide: true },
);

let client = null;
try {
  const wsUrl = await pageTarget(port);
  if (!wsUrl) throw new Error('Edge 起来了但没有可调试页面');
  client = await connect(wsUrl);
  await client.send('Page.enable');
  await client.send('Runtime.enable');

  // 先确认这个 profile 真的是登录态（只看有没有 SESSDATA 这个 cookie 名，不读值）
  await client.send('Page.navigate', { url: 'https://www.bilibili.com/' });
  await sleep(2500);
  const loggedIn = await client.evaluate(`(async () => {
    try {
      const r = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' });
      const j = await r.json();
      return JSON.stringify({ code: j.code, isLogin: j?.data?.isLogin === true, uname: j?.data?.uname || '' });
    } catch (e) { return JSON.stringify({ error: String(e) }); }
  })()`);
  say(`登录态检查：${loggedIn}`);

  let pass = 0;
  let fail = 0;
  const check = (ok, label, detail = '') => {
    if (ok) pass += 1;
    else fail += 1;
    say(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  };

  for (const bv of VIDEOS) {
    say('');
    say(`=== ${bv} ===`);
    await client.send('Page.navigate', { url: `https://www.bilibili.com/video/${bv}` });
    await sleep(7000);

    const info = await client.evaluate(`(async () => {
      const out = { bv: ${JSON.stringify(bv)} };
      out.title = (document.querySelector('h1.video-title, .video-title') || {}).textContent || document.title;
      // 播放器是否已经渲染、控制栏里有没有字幕入口
      out.playerClassHits = [...new Set([...document.querySelectorAll('[class*="subtitle"]')].map(e => e.className).slice(0, 8))];
      out.ctrlSubtitle = Boolean(document.querySelector('.bpx-player-ctrl-subtitle, .bilibili-player-video-btn-subtitle, [class*="subtitle-btn"]'));
      // 视频信息（cid）：从页面状态里拿，拿不到就调 pagelist
      try {
        const st = window.__INITIAL_STATE__;
        out.cid = st?.videoData?.cid ?? st?.cid ?? null;
        out.aid = st?.aid ?? st?.videoData?.aid ?? null;
        out.subtitleInState = st?.videoData?.subtitle ? Object.keys(st.videoData.subtitle) : null;
      } catch (e) {
        out.stateError = String(e);
      }
      if (!out.cid) {
        try {
          const r = await fetch('https://api.bilibili.com/x/player/pagelist?bvid=' + ${JSON.stringify(bv)}, { credentials: 'include' });
          const j = await r.json();
          out.cid = j?.data?.[0]?.cid ?? null;
          out.aid = out.aid ?? j?.data?.[0]?.aid ?? null;
        } catch (e) { out.pagelistError = String(e); }
      }
      // 关键一步：带 cookie 请求字幕列表（页面内请求会自动带 SESSDATA）
      try {
        const u = new URL('https://api.bilibili.com/x/player/wbi/v2');
        u.searchParams.set('aid', String(out.aid ?? ''));
        u.searchParams.set('cid', String(out.cid ?? ''));
        const r = await fetch(u.toString(), { credentials: 'include' });
        const j = await r.json();
        out.playerV2Code = j.code;
        out.playerV2Message = j.message;
        const subs = j?.data?.subtitle?.subtitles ?? [];
        out.subtitles = subs.map(s => ({ lan: s.lan, lan_doc: s.lan_doc, ai: s.ai_status ?? null }));
        out.subtitleAllow = j?.data?.subtitle?.allow_submit ?? null;
      } catch (e) {
        out.subtitleError = String(e);
      }
      return JSON.stringify(out);
    })()`);

    let o;
    try {
      o = JSON.parse(info);
    } catch {
      check(false, `${bv} 读页面状态`, String(info).slice(0, 150));
      continue;
    }
    say(`标题：${(o.title ?? '').trim().slice(0, 60)}`);
    say(`cid=${o.cid} aid=${o.aid} playerV2=${o.playerV2Code ?? '?'} ${o.playerV2Message ?? ''}`);
    say(`页面里 class 带 subtitle 的元素：${JSON.stringify(o.playerClassHits ?? [])}`);
    say(`控制栏字幕按钮：${o.ctrlSubtitle ? '有' : '没有'}`);
    const subs = Array.isArray(o.subtitles) ? o.subtitles : [];
    say(`字幕轨：${subs.length ? JSON.stringify(subs) : '无'}`);
    if (o.subtitleError) say(`字幕接口报错：${o.subtitleError}`);

    check(o.playerV2Code === 0, `${bv} 字幕接口调通了`, `code=${o.playerV2Code ?? '?'}`);
    const ja = subs.find((s) => /^ja|^ai-ja/i.test(String(s.lan ?? '')) || /日/.test(String(s.lan_doc ?? '')));
    say(ja ? `→ 这条视频有日语字幕轨：${ja.lan_doc}（${ja.lan}）` : '→ 这条视频没有日语字幕轨');
  }

  say('');
  say(fail === 0 ? '结论：所有视频字幕接口都调通了（有/无字幕轨按上面逐条看）' : `有 ${fail} 项接口没调通`);
  process.exitCode = fail === 0 ? 0 : 1;
} catch (e) {
  say(`出错：${e?.message ?? e}`);
  process.exitCode = 1;
} finally {
  try {
    if (client) await client.send('Browser.close');
  } catch {
    /* 忽略 */
  }
  await sleep(500);
  try {
    edge.kill('SIGKILL');
  } catch {
    /* 忽略 */
  }
}
