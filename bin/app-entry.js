/**
 * 服务端入口：exe 以 --server 启动时，从这里起 HTTP 服务。
 *
 * 单独抽一个文件出来，是为了不让 SEA 单文件里塞满服务端的依赖，
 * 也方便 vocab-client.js 用 import() 动态加载。
 */
import { startApp } from '../src/app/server.js';

export async function serve({ root, port, host = '127.0.0.1' }) {
  const app = await startApp({ cwd: root, port, host });
  return app;
}
