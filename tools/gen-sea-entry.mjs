import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const buildDir = join(root, 'build');

// 要打进单文件的目录（相对项目根）
const DIRS = ['src', 'app', 'bin'];
const FILES = ['package.json', 'config.default.json'];

// 明确排除：不该进发布的二进制/临时/测试产物
const SKIP = [
  /(^|[\\/])data([\\/]|$)/i,
  /(^|[\\/])runs([\\/]|$)/i,
  /(^|[\\/])versions([\\/]|$)/i,
  /(^|[\\/])samples([\\/]|$)/i,
  /(^|[\\/])models([\\/]|$)/i,
  /(^|[\\/])test([\\/]|$)/i,
  /(^|[\\/])tools([\\/]|$)/i,
  /(^|[\\/])node_modules([\\/]|$)/i,
  /\.ico$/i,
  /sheet\.png$/i,
  /^app[\\/]public[\\/]img[\\/]/i,   // 图片走文件系统，不进包
  /^bin[\\/]vocab-client\.js$/i,     // 启动器本身作为入口单独处理
];

function walk(dir, out = []) {
  const { readdirSync, statSync } = fs;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(root, full).replace(/\\/g, '/');
    if (SKIP.some((re) => re.test(rel))) continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(rel);
  }
  return out;
}

import * as fs from 'node:fs';

const files = [];
for (const d of DIRS) {
  const p = join(root, d);
  if (existsSync(p)) files.push(...walk(p));
}
for (const f of FILES) if (existsSync(join(root, f))) files.push(f);

files.sort();
console.log(`打包 ${files.length} 个文件进单文件`);

// ── 生成 SEA 入口：内置文件表 + 按需读取 ──
const entry = `// === 自动生成，不要手改（tools/build-exe.mjs 生成） ===
import { existsSync as _ex, readFileSync as _rd } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EMBEDDED = Symbol.for('vocab.embedded');
if (!globalThis[EMBEDDED]) {
  const files = {};
  globalThis[EMBEDDED] = files;
  await import('./sea-files.js');
}

const here = dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(join(here, 'vocab-client.js')).href);
`;

// 文件表用一个生成的模块装，避免把几十 KB 字面量塞进入口
const lines = [];
lines.push('const F = globalThis[Symbol.for(\'vocab.embedded\')];');
lines.push('import { readFileSync } from \'node:fs\';');
lines.push('import { dirname, join, isAbsolute } from \'node:path\';');
lines.push('import { fileURLToPath } from \'node:url\';');
lines.push('');
lines.push('const here = dirname(fileURLToPath(import.meta.url));');
lines.push('const TABLE = {');
for (const f of files) {
  lines.push(`  ${JSON.stringify(f)}: ${JSON.stringify(relative(buildDir, join(root, f)).replace(/\\/g, '/'))},`);
}
lines.push('};');
lines.push('');
lines.push('for (const [rel, src] of Object.entries(TABLE)) {');
lines.push('  try {');
lines.push('    F[rel] = readFileSync(join(here, \'..\', src), \'utf8\');');
lines.push('  } catch {');
lines.push('    // 读不到的留给调用方报错');
lines.push('  }');
lines.push('}');

mkdirSync(buildDir, { recursive: true });
