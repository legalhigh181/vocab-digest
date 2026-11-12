/**
 * 浏览器自检：不靠人眼看，用最小 DOM 垫片把真实的 app/public/app.js 跑起来。
 *
 * 这个项目的界面逻辑全在 app.js 里（语言徽标、读音行、搜索、错误提示都是它渲染的），
 * 而本机没有可自动化的浏览器。做法是：
 *   1. 解析 app.html，按 id 建一棵最小的 DOM 树（只有界面用得到的那些能力）
 *   2. 把 app.js 当成普通脚本丢进去执行（它就是 IIFE，不需要 ES module）
 *   3. 给 window.fetch 接上真实的服务端（startApp 起在随机端口）
 *   4. 像用户一样点选：切语言、点词条、搜假名、看错误提示，然后把正文捞出来断言
 *
 * 局限要说清楚：这不是真浏览器。CSS 排版、真实浏览器的事件循环、xss 过滤——这些都验不了。
 * 它验的是「界面拿到数据后会不会把假名/未收录/徽标画出来、切语言会不会串运行」。
 *
 * 跑法：node tools/probe-browser.mjs
 */
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startApp } from '../src/app/server.js';
import { runDigestAsync } from '../src/run.js';

// URL.pathname 会把中文目录百分号编码，必须走 fileURLToPath
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// ── 最小 DOM ────────────────────────────────────────────────────────────

class DomNode {
  constructor(tag, tagName) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.nodeName = this.tagName;
    this.children = [];
    this.parentNode = null;
    this.attrs = new Map();
    this.style = {};
    this.dataset = {};
    this.classList = makeClassList(this);
    this.listeners = {};
    this._text = '';
    this.value = '';
    this.checked = false;
    this.hidden = false;
    this.disabled = false;
    this.selected = false;
    this._className = '';
    this._tagNameHint = tagName ?? '';
  }

  // 真实 DOM 里 className 和 class 属性是同一个东西：app.js 直接写 n.className = 'item'，
  // 垫片必须同步到 classList，否则按 .item 找卡片会全部落空（第一版就踩了这个）。
  get className() { return this._className ?? ''; }
  set className(v) {
    this._className = v == null ? '' : String(v);
    this.attrs.set('class', this._className);
    const cl = this.classList;
    for (const c of [...cl._set]) cl.remove(c);
    for (const c of this._className.split(/\s+/).filter(Boolean)) cl.add(c);
  }

  get id() { return this.attrs.get('id') ?? ''; }
  set id(v) { this.attrs.set('id', v); }
  get title() { return this.attrs.get('title') ?? ''; }
  set title(v) { this.attrs.set('title', v); }
  get href() { return this.attrs.get('href') ?? ''; }
  set href(v) { this.attrs.set('href', v); }
  get src() { return this.attrs.get('src') ?? ''; }
  set src(v) { this.attrs.set('src', v); }

  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.get(k) ?? null; }
  removeAttribute(k) { this.attrs.delete(k); }

  get textContent() {
    if (this.children.length === 0) return this._text;
    return this.children.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    this.children = [];
    this._text = v == null ? '' : String(v);
  }

  get innerHTML() { return this.textContent; }
  set innerHTML(v) {
    this.children = [];
    this._text = v == null ? '' : String(v);
  }

  appendChild(c) {
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  insertBefore(c, ref) {
    const i = this.children.indexOf(ref);
    c.parentNode = this;
    this.children.splice(i < 0 ? this.children.length : i, 0, c);
    return c;
  }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
    return c;
  }
  append(...xs) { for (const x of xs) this.appendChild(x); }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }

  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn);
  }
  dispatch(type, ev = {}) {
    const evt = { type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...ev };
    for (const fn of this.listeners[type] ?? []) fn.call(this, evt);
    const inline = this['on' + type];
    if (typeof inline === 'function') inline.call(this, evt);
    return evt;
  }
  click() { return this.dispatch('click'); }
  focus() {}
  scrollIntoView() {}
  // Model only visibility here; actual focus trapping/Escape are checked in the browser.
  showModal() { this.open = true; }
  close() { this.open = false; }

  /** 只有目录：搜索、按 id 找元素都靠它 */
  walk(fn) {
    fn(this);
    for (const c of this.children) c.walk(fn);
  }
  querySelectorAll(sel) {
    const out = [];
    this.walk((n) => {
      if (n === this) return;
      if (sel.startsWith('#')) { if (n.id === sel.slice(1)) out.push(n); return; }
      if (/^\.[\w-]+$/.test(sel)) { if (n.classList.contains(sel.slice(1))) out.push(n); return; }
      if (n.tagName === sel.toUpperCase()) out.push(n);
    });
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }

  _all() { return Array.prototype.slice.call(this.children); }
}

function makeClassList(node) {
  const set = new Set();
  return {
    _set: set,
    add: (...cs) => { for (const c of cs) set.add(c); sync(); },
    remove: (...cs) => { for (const c of cs) set.delete(c); sync(); },
    contains: (c) => set.has(c),
    toggle: (c, force) => {
      const add = force === undefined ? !set.has(c) : force;
      if (add) set.add(c); else set.delete(c);
      sync();
      return add;
    },
    get value() { return [...set].join(' '); },
  };
  function sync() { node._className = [...set].join(' '); node.attrs.set('class', node._className); }
}

/** 从 html 源码里建树：只要 id、标签、class 和文本节点 */
function parseHtml(html) {
  const root = new DomNode('body');
  const stack = [root];
  const re = /<(\/?)([a-zA-Z0-9]+)([^>]*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    const [, close, tag, rawAttrs, selfClose, text] = m;
    if (text != null) {
      if (text.trim()) stack[stack.length - 1].appendChild(new DomNode('#text-text'));
      if (text.trim()) stack[stack.length - 1].children.at(-1)._text = text;
      continue;
    }
    if (close) { if (stack.length > 1) stack.pop(); continue; }
    const node = new DomNode(tag);
    for (const am of rawAttrs.matchAll(/([a-zA-Z0-9_:-]+)(?:="([^"]*)")?/g)) {
      const k = am[1];
      const v = am[2] ?? '';
      node.attrs.set(k, v);
      if (k === 'class') node.className = v;
      if (k === 'value') node.value = v;
      if (k === 'checked') node.checked = true;
      if (k === 'id') node._id = v;
    }
    stack[stack.length - 1].appendChild(node);
    if (!selfClose && !/^(img|br|input|meta|link|hr)$/i.test(tag)) stack.push(node);
  }
  return root;
}

// ── 环境装配 ────────────────────────────────────────────────────────────

const work = mkdtempSync(join(tmpdir(), 'vd-probe-browser-'));
const srt = join(work, 'ja.srt');
writeFileSync(srt,
  '1\r\n00:00:01,000 --> 00:00:05,000\r\n日本の学生は毎日勉強します。\r\n\r\n'
  // 故意塞一个 kuromoji 一定不认的写法（片假名加长音＋生造复合），用来验「未收录」标记
  + '2\r\n00:00:05,000 --> 00:00:09,000\r\nワクワクする気持ちを大切に。\r\n\r\n'
  + '3\r\n00:00:09,000 --> 00:00:12,000\r\nゾルヴァイクスハイムを訪ねた。\r\n', 'utf8');

await runDigestAsync({ inputs: [srt], cwd: work, runId: 'ja-run', language: 'ja' });

const app = await startApp({ cwd: work, port: 0 });
const html = readFileSync(join(ROOT, 'app/public/app.html'), 'utf8');
const root = parseHtml(html);

// 数据槽：真实服务端会把 state/view 直接写进 app.html，这里走同样的接口取
const fakeRequest = async (url) => {
  const r = await fetch(new URL(url, app.url));
  return { json: () => r.json(), text: () => r.text(), ok: r.ok };
};

// 先把数据槽填上，跟服务端渲染首页时一样
const idx = (frag) => html.indexOf(frag);
void idx;
const slotState = root.querySelector('#d-state');
const slotView = root.querySelector('#d-view');
slotState.textContent = JSON.stringify(await (await fetch(new URL('/api/state', app.url))).json());
slotView.textContent = JSON.stringify(await (await fetch(new URL('/api/view?runId=ja-run', app.url))).json());

const document = {
  getElementById: (id) => root.querySelector('#' + id) ?? makeStub(id),
  querySelector: (s) => root.querySelector(s),
  querySelectorAll: (s) => root.querySelectorAll(s),
  createElement: (t) => new DomNode(t),
  createTextNode: (t) => { const n = new DomNode('#text'); n._text = String(t); return n; },
  body: root,
  addEventListener() {},
};

/** 界面会碰一些页面里没有的元素（比如表情区），给个不抛异常的壳 */
function makeStub(id) {
  const n = new DomNode('div');
  n._id = id;
  n.attrs.set('id', id);
  return n;
}

const toasts = [];
const window = {
  location: { href: app.url, search: '', hash: '' },
  open(url) { window.__opened = url; },
  fetch: async (url, init) => {
    const full = String(url).startsWith('http') ? url : new URL(url, app.url).toString();
    const r = await fetch(full, init);
    return { json: () => r.json(), text: () => r.text(), ok: r.ok, status: r.status };
  },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t),
  addEventListener() {},
  localStorage: { getItem: () => null, setItem() {} },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  devicePixelRatio: 1,
  innerWidth: 1440,
  innerHeight: 900,
  document,
  console,
  Math,
  Date,
  JSON,
  URLSearchParams,
  Promise,
  Object,
  Array,
  String,
  Number,
  Boolean,
  Error,
  encodeURIComponent,
  decodeURIComponent,
};
window.window = window;
window.self = window;

const context = createContext(window);
context.document = document;
context.fetch = window.fetch;
// 真浏览器里这些都存在；垫片必须补上，否则 setInterval/clearTimeout 之类会变成 ReferenceError。
// 用宿主进程的定时器：垫片跑在同一个事件循环里，行为与浏览器一致。
context.setTimeout = setTimeout;
context.clearTimeout = clearTimeout;
context.setInterval = setInterval;
context.clearInterval = clearInterval;
context.console = console;
context.navigator = { userAgent: 'probe-browser' };
context.FormData = class FormData { constructor() { this._m = new Map(); } append(k, v) { this._m.set(k, v); } };

const appJs = readFileSync(join(ROOT, 'app/public/app.js'), 'utf8');
runInContext(appJs, context, { filename: 'app.js' });

const $ = (id) => root.querySelector('#' + id) ?? makeStub(id);
const tick = async (n = 6) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 25)); };

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail });

/** 选中某一运行：模拟点击左侧列表里的那一项 */
async function selectRunById(runId) {
  const box = $('runs');
  const row = box.children.find((c) => JSON.stringify(c).includes(runId) || c.textContent.includes(runId));
  if (row) realClick(row); else await postApp('/api/view?runId=' + runId);
  await tick(10);
}
async function postApp() { /* 占位：真实交互一律走 DOM */ }

// ── 1 · 首页数据 ───────────────────────────────────────────────────────

/** 像用户一样真点一下：给所有祖先/目标挂 click 监听再 dispatch 一路冒泡 */
function realClick(node) {
  const chain = [];
  for (let n = node; n; n = n.parentNode) chain.unshift(n);
  const hits = [];
  for (const n of chain) {
    const own = [...(n.listeners.click ?? [])];
    if (typeof n.onclick === 'function') own.push(n.onclick);
    if (own.length) hits.push({ n, own });
  }
  const evt = {
    type: 'click', target: node, currentTarget: node, bubbles: true, button: 0,
    preventDefault() {}, stopPropagation() { evt._stopped = true; },
  };
  for (const { n, own } of hits) {
    evt.currentTarget = n;
    for (const fn of own) { fn.call(n, evt); if (evt._stopped) return evt; }
  }
  return evt;
}

await tick(10);
check('首页渲染出运行列表', $('runs').children.length > 0, `运行数 ${$('runs').children.length}`);
check('左侧语言下拉有 en / ja', $('langSel').children.length === 2,
  `选项 ${$('langSel').children.map((o) => o.value).join(',')}`);
check('新建词表可以选语言', $('newListLang').children.length === 2,
  `选项 ${$('newListLang').children.map((o) => o.value).join(',')}`);

// ── 2 · 选中日文运行：徽标 + 读音 + 未收录 ──────────────────────────────

const runRow = $('runs').children[0];
realClick(runRow);
await tick(12);

check('中栏语言徽标显示 JA', $('langBadge').textContent === 'JA', `实际「${$('langBadge').textContent}」`);
// 卡片上的读音必须是**这一条自己的**读数，而不是页面上随便冒出来的假名
const view = await (await fetch(new URL('/api/view?runId=ja-run', app.url))).json();
const readings = (view.items || []).filter((i) => i.reading).map((i) => i.reading);
check('服务端给了读音', readings.length > 0, readings.join(','));
const itemsText = $('items').textContent;
check('词条卡片里出现每条自己的读音',
  readings.length > 0 && readings.some((r) => itemsText.includes(r)), readings.join(','));
check('卡片的假名不是从例句里抄来的（读音区独立存在）',
  ($('items').querySelectorAll('.reading').length > 0), `.reading 节点 ${$('items').querySelectorAll('.reading').length} 个`);
check('日语运行不显示英文音标', ($('items').querySelectorAll('.phon').length === 0),
  `.phon 节点 ${$('items').querySelectorAll('.phon').length} 个`);
check('标题按日文语言取', String(view.title || '').includes('日语'),
  `视图标题「${view.title}」`);

// 点第一个词条看详情
const firstCard = $('items').children.find((c) => c.classList.contains('item'));
check('至少有一张词条卡', Boolean(firstCard));
if (firstCard) {
  realClick(firstCard);
  await tick(6);
  const d = $('detail').textContent;
  check('详情里有读音行', /[ァ-ヴー]{2,}/.test(d), d.slice(0, 120));
  check('详情里没有英文词典链接', !$('detail').querySelectorAll('a.camb').length);
  check('详情里没有英文音标', $('detail').querySelectorAll('.phon').length === 0
  && !$('detail').textContent.includes('剑桥'), $('detail').textContent.slice(0, 120));
}

// ── 3 · 搜索：按假名能搜到 ─────────────────────────────────────────────

const before = $('items').children.length;
$('q').value = 'にほん';
$('q').dispatch('input');
await tick(12);
const after = $('items').children.length;
check('按平假名能搜到词条', after > 0 && after < before, `搜前 ${before} 张，搜后 ${after} 张`);
$('q').value = '';
$('q').dispatch('input');
await tick(10);

// ── 4 · 未收录词：标「未收录」，绝不编假名 ───────────────────────────────
// 拿真实数据决定断言方向：kuromoji 认得的词有 reading，认不得的才是 unknown。

const unknownItem = (view.items || []).find((i) => i.unknown);
$('q').value = unknownItem ? unknownItem.word : 'ワクワク';
$('q').dispatch('input');
await tick(10);
const waku = $('items').children.find((c) => c.classList.contains('item'));
if (waku) {
  realClick(waku);
  await tick(6);
  const d = $('detail').textContent;
  const cardText = waku.textContent;
  if (unknownItem) {
    // 判据是「词条自己的读音区」：不能有片假名读音，只能有「未收录」。
    // 注意别拿整张卡的文字去验：这个词本身就是片假名，按字符类判会自己命中自己。
    const row = waku.querySelectorAll('.reading')[0];
    check('未收录词标了「未收录」且读音区不给假名',
      d.includes('未收录') && Boolean(row) && row.textContent.includes('未收录')
      && !/[ァ-ヴー]{3,}/.test(row.textContent.replace('未收录', '')),
      `读音区「${row ? row.textContent : '（无）'}」`);
  } else {
    // 这条样本里没有 kuromoji 认不得的词，就没法验「未收录」—— 必须明说，不能记成通过
    check('样本里没有 unkonwn 词条，未收录标记未能验证', false,
      `unknown 数 ${(view.items || []).filter((i) => i.unknown).length}`);
  }
}
$('q').value = '';
$('q').dispatch('input');
await tick(10);

// ── 5 · 切语言不串运行 ─────────────────────────────────────────────────

const viewBefore = $('subtitle').textContent;
$('viewLang').value = 'en';
$('viewLang').dispatch('change');
await tick(8);
check('切界面语言不改动当前运行的标题', $('subtitle').textContent === viewBefore,`${viewBefore} → ${$('subtitle').textContent}`);
check('切界面语言后徽标仍是 JA', $('langBadge').textContent === 'JA', $('langBadge').textContent);

// ── 6 · 错误提示：抓取失败要留在日志框里 ────────────────────────────────
// 注入一个立刻失败的取数实现：探针不该真去访问 B 站（慢、且会受网络影响）。
// 走的是新接口 /api/run/fetch/start → 轮询 /api/tasks?id= → 拿最终结果这一整条链路。
app.setFetchVideo(async (o) => ({
  ok: false, error: '模拟失败：这个视频没有字幕', code: 'NO_SUBTITLE', dir: o.outDir, written: [],
}));
$('link').value = 'https://www.bilibili.com/video/BV0000000000';
await realClick($('btnFetch'));
let logText = '';
for (let i = 0; i < 60; i += 1) {
  await tick(50);
  logText = $('fetchLog').textContent;
  if (/失败/.test(logText)) break;
}
check('抓取失败时日志框里有失败原因', /失败/.test(logText), logText.slice(0, 120));
check('抓取失败时不会静默（要么日志要么 toast）', logText.length > 0 || $('toastText').textContent.length > 0);
check('任务结束后取消按钮回到禁用态', $('btnCancelFetch').disabled === true);

// ── 汇总 ────────────────────────────────────────────────────────────────

app.server.close();
try { rmSync(work, { recursive: true, force: true }); } catch { /* 占用 */ }

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
console.log(`\n浏览器自检：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
