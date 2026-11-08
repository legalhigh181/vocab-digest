/**
 * 双击启动的本地词汇库：只用 node 内置模块起一个 http 服务，然后打开默认浏览器。
 *
 * 用法：node bin\vocab-app.js [--cwd <项目根>] [--port 7777] [--no-open]
 * 或者直接双击仓库根目录的「启动词汇库.cmd」。
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startApp } from '../src/app/server.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  return process.argv[i + 1];
}

const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const cwd = resolve(arg('--cwd', pkgRoot));
const port = Number(arg('--port', 7788));
const noOpen = process.argv.includes('--no-open');

const listenHost = '127.0.0.1';

const { url, port: realPort } = await startApp({ cwd, host: listenHost, port });

console.log(`词汇库已启动：${url}`);
console.log(`  工作目录: ${cwd}`);
console.log(`  关闭窗口或 Ctrl+C 结束服务`);

if (!noOpen) {
  const cmd = process.platform === 'win32'
    ? `start "" "${url}"`
    : process.platform === 'darwin'
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  const shell = process.platform === 'win32' ? 'cmd.exe' : 'sh';
  const args = process.platform === 'win32' ? ['/c', cmd] : ['-c', cmd];
  try {
    spawn(shell, args, { detached: true, stdio: 'ignore' }).unref();
  } catch (e) {
    console.log(`（自动打开浏览器失败：${e.message}，请手动访问 ${url}）`);
  }
}
