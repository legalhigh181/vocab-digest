/**
 * 桌面客户端启动器（同一份代码两种身份）：
 *
 *   A. 作为 .exe 运行时（SEA 单文件）：
 *      - 自己是服务端。参数带 --port 就直接起 HTTP 服务（不起浏览器），
 *        「词汇库」双击时是桌面入口，起服务 + 开窗口。
 *      - 「拉起服务」= 用自己再 spawn 一次，带 --server 参数。
 *        这样别人电脑上没装 Node 也能跑，因为 Node 运行时就在 exe 里。
 *
 *   B. 作为脚本运行时（node bin/vocab-client.js）：
 *      - 退回老办法：spawn 本机的 node 去跑 bin/vocab-app.js。
 *
 * 环境变量 VOCAB_ROOT 可指定项目根目录；否则按自身位置推算。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── 判断身份 ──
// 打包成 SEA 后，execPath 是 exe；脚本运行时 execPath 是 node.exe
const isSea = typeof process.execPath === 'string'
  && !/node(\.exe)?$/i.test(process.execPath);

const here = (() => {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return '';
  }
})();

const root = resolve(
  process.env.VOCAB_ROOT
    || (isSea ? dirname(process.execPath) : join(here, '..')),
);

const argv = process.argv.slice(2);
const portArg = argv.indexOf('--port');
const port = Number(
  (portArg >= 0 ? argv[portArg + 1] : null)
  ?? process.env.VOCAB_PORT
  ?? 7788,
);
const base = `http://127.0.0.1:${port}`;
const serverOnly = argv.includes('--server');

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
];

function pickBrowser() {
  for (const p of BROWSERS) if (p && existsSync(p)) return p;
  return '';
}

async function alive() {
  try {
    const r = await fetch(`${base}/api/state`, { signal: AbortSignal.timeout(1200) });
    return r.ok;
  } catch {
    return false;
  }
}

async function waitUp(ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await alive()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/** 起服务：exe 模式用自己，脚本模式用本机 node 跑 vocab-app.js */
function startServer() {
  const opts = {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  };
  const child = isSea
    ? spawn(process.execPath, ['--server', '--port', String(port)], opts)
    : spawn(process.execPath, [join(root, 'bin', 'vocab-app.js'), '--cwd', root, '--port', String(port), '--no-open'], opts);
  child.unref();
  return child;
}

function openWindow(browser) {
  // 浏览器配置目录放用户目录，别塞进项目里 —— 否则编码体检、备份都会被它污染
  const baseDir = process.env.LOCALAPPDATA || join(process.env.USERPROFILE || root, 'AppData', 'Local');
  const profile = join(baseDir, 'VocabDigest', 'client-profile');
  mkdirSync(profile, { recursive: true });
  const args = [
    `--app=${base}/`,
    `--user-data-dir=${profile}`,
    '--window-size=1360,900',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
  ];
  const child = spawn(browser, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

async function main() {
  // ── exe 模式 + --server：直接把自己变成服务端 ──
  if (isSea && serverOnly) {
    const { startApp } = await import('./app-entry.js');
    const app = await startApp({ cwd: root, port, host: '127.0.0.1' });
    process.on('SIGTERM', () => app.server.close());
    return;
  }

  if (!(await alive())) {
    startServer();
    const ok = await waitUp();
    if (!ok) {
      // 起不来就直接把日志窗口留给用户，比默默失败好
      spawnSync('cmd', ['/c', 'start', '', 'cmd', '/k', `cd /d "${root}" && node bin\\vocab-app.js --cwd . --port ${port}`], {
        stdio: 'ignore',
        windowsHide: false,
      });
      return;
    }
  }
  const browser = pickBrowser();
  if (browser) {
    openWindow(browser);
  } else {
    // 没有 Edge/Chrome 就退回默认浏览器，至少能用
    spawn('cmd', ['/c', 'start', '', `${base}/`], { detached: true, stdio: 'ignore' }).unref();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
