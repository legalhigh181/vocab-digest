/**
 * 打发布包：白名单式收集 + 从锁定依赖装出独立 staging + 打 zip + 报大小与 SHA-256。
 *
 * 三条原则：
 *   1. **白名单**，不是「全复制再删」——以后新增的临时文件才不会悄悄混进去。
 *   2. **不复制开发机的 node_modules**：只按 package-lock.json 里的生产依赖闭包，
 *      逐个校验版本后放进 staging。开发依赖、多余包、残留缓存一律不带。
 *   3. kuromoji 的词典跟着包走（约 17MB），解压即离线可分词；
 *      whisper 模型（465MB）和英汉词典 ecdict.csv（66MB）继续外置。
 *
 * 用法：
 *   node tools/pack-release.mjs                 # 默认 dist/词汇库-v1.0-windows.zip
 *   node tools/pack-release.mjs --no-zip        # 只做 staging，方便调试
 */
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { makeZip, readZip } from '../src/docx/zip.js';

const ROOT = resolve(import.meta.dirname, '..');
const STAGING = join(ROOT, 'build', 'release-staging');
const ZIP = join(ROOT, 'dist', '词汇库-v1.0-windows.zip');

// ── 整目录带走 ─────────────────────────────────────────────────────────
const DIRS = ['bin', 'src', 'app'];

// ── 根目录文件 ────────────────────────────────────────────────────────
const ROOT_FILES = [
  'package.json',
  'package-lock.json',
  'README.md',
  '使用说明.md',
  '发布说明.md',
  'AGENTS.md',
  'LICENSE',
  'config.default.json',
  'cordis.patch.yml',
  '安装.cmd',
  '下载词典.cmd',
  '启动词汇库.cmd',
  '客户端.vbs',
];

// ── 运行期真要用的脚本（.ps1 一律不进包：执行策略和防火墙的坑太多）──
const TOOLS = ['install.vbs', 'install-shortcuts.vbs', 'download-dict.vbs'];

// ── data：只带规则与模板，不带词典、不带个人词表 ────────────────────────
const DATA_FILES = [
  'colloquial.json',
  'lemmatize.exceptions.json',
  'pos.json',
  'stopword.txt',
  'README.md',
  join('base', 'base.txt'),
  join('ja', 'stopword.txt'),
  join('ja', 'meanings.json'),
  join('ja', 'README.md'),
];

// ── 个人进度文件：不能带本人内容，只放一份空模板 ────────────────────────
const DATA_TEMPLATES = {
  [join('known', 'known.txt')]: '# 已掌握的英文词：一行一个原形（如 abandon）。出现在这里的不进正文。\n',
  [join('ja', 'known.txt')]: '# 已掌握的日文词：一行一个原形（如 食べる）。出现在这里的不进正文。\n',
};

// ── 示例数据：让「解压后先跑一次看看」这条路真的能走通 ──────────────────
const FIXTURES = ['bilibili-subtitle.json', 'danmaku.xml', 'lecture.srt'];

/**
 * 单独排除的大块文件（不是「危险」，只是「运行时用不到」）：
 *   - app/public/img/*-sheet.png 是抠图前的设定原图，线上用的是抠好的小图；
 *     这几张合起来约 15MB，进了包只是白白拖慢下载。
 */
const EXCLUDE = [/app[\\/]public[\\/]img[\\/][a-z0-9-]*-sheet\.png$/i];

/**
 * 随包依赖里可以扔掉的子目录：上游自带的测试夹具与示例。
 * 只扔 test/demo/example —— 词典（dict/）、构建产物（build/）、源码（src/）和许可证都留着。
 */
const PRUNE = { kuromoji: ['test', 'demo', 'example'] };

/**
 * 任何层级都不许出现的东西。兜底用——白名单已经拦住了，这里再验一遍，
 * 是为了防止将来有人往 src/、app/ 里塞了运行产物。
 */
const FORBIDDEN = /(^|[\\/])(runs|versions|models|samples|\.trash|\.git)([\\/]|$)|\.part\d*$|\.bak\d*$|\.csv$|ggml-.*\.bin$|_sheet\.png$|^data[\\/]wordlists[\\/]|^data[\\/]ecdict/i;

// ── 工具函数 ──────────────────────────────────────────────────────────

let copied = 0;
const skipped = [];

function put(src, destRel) {
  const rel = destRel.split(sep).join('/');
  if (!existsSync(src)) {
    skipped.push(`缺文件 ${rel}`);
    return;
  }
  if (FORBIDDEN.test(rel)) {
    skipped.push(`命中禁令 ${rel}`);
    return;
  }
  if (EXCLUDE.some((r) => r.test(rel))) {
    skipped.push(`运行时用不到 ${rel}`);
    return;
  }
  const dest = join(STAGING, destRel);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  copied += 1;
}

function putText(destRel, text) {
  const dest = join(STAGING, destRel);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, text, 'utf8');
  copied += 1;
}

function walkCopy(srcDir, destRel, { skipDirs = [] } = {}) {
  const entries = readdirSync(srcDir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory()) {
      if (skipDirs.includes(e.name)) continue;
      walkCopy(join(srcDir, e.name), join(destRel, e.name), { skipDirs });
    } else if (e.isFile()) {
      put(join(srcDir, e.name), join(destRel, e.name));
    }
  }
}

/** 生产依赖闭包：从 package.json 的 dependencies 出发，沿着包自己的 dependencies 走 */
function prodClosure() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
  const locked = new Map();
  for (const [k, v] of Object.entries(lock.packages ?? {})) {
    if (!k.startsWith('node_modules/')) continue;
    locked.set(k.slice('node_modules/'.length), v.version);
  }
  const seen = new Map(); // name -> version
  const queue = Object.keys(pkg.dependencies ?? {});
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    const dir = join(ROOT, 'node_modules', name);
    if (!existsSync(join(dir, 'package.json'))) {
      throw new Error(`依赖没装：${name}（先 npm ci）`);
    }
    const p = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const want = locked.get(name);
    if (want && p.version !== want) {
      throw new Error(`依赖版本与 lock 不一致：${name} 装的是 ${p.version}，lock 要 ${want}`);
    }
    seen.set(name, p.version);
    for (const dep of Object.keys(p.dependencies ?? {})) queue.push(dep);
  }
  return seen;
}

function installProdDeps() {
  const versions = prodClosure();
  const nm = join(STAGING, 'node_modules');
  mkdirSync(nm, { recursive: true });
  for (const [name, version] of versions) {
    const src = join(ROOT, 'node_modules', name);
    const dest = join(nm, name);
    // 整个包搬过去（含 LICENSE / NOTICE / 词典），不做裁剪：
    // 少一个文件省不了多少，漏了许可或词典却是事故。
    walkCopy(src, join('node_modules', name));
    let pruned = '';
    for (const sub of PRUNE[name] ?? []) {
      const p = join(dest, sub);
      if (existsSync(p)) {
        rmSync(p, { recursive: true, force: true });
        pruned += `（剔除 ${sub}/）`;
      }
    }
    console.log(`  依赖 ${name}@${version}${pruned}`);
  }
  return versions;
}

function writeNotices(versions) {
  const licenses = {
    kuromoji: 'Apache-2.0（LICENSE-2.0.txt，另见 NOTICE.md）',
    async: 'MIT',
    doublearray: 'MIT',
    lodash: 'MIT',
    zlibjs: 'MIT',
  };
  const lines = [
    '# 第三方组件',
    '',
    '本发布包内含以下 npm 生产依赖（版本与 package-lock.json 一致）。',
    '每个包的许可证原文都在 `node_modules/<包名>/` 里随包附带。',
    '',
    '| 组件 | 版本 | 许可证 | 用途 |',
    '|---|---|---|---|',
  ];
  const purpose = {
    kuromoji: '日文分词（含词典，约 17MB，解压即可离线使用）',
    async: 'kuromoji 的间接依赖',
    doublearray: 'kuromoji 的词典结构依赖',
    lodash: 'async 的间接依赖',
    zlibjs: 'kuromoji 的压缩词典依赖',
  };
  for (const [name, version] of [...versions.entries()].sort()) {
    lines.push(`| ${name} | ${version} | ${licenses[name] ?? '见包内 LICENSE'} | ${purpose[name] ?? ''} |`);
  }
  lines.push(
    '',
    '## 不随包分发的外部资源',
    '',
    '- **英汉词典 `data/ecdict.csv`**（约 66MB，ECDICT，MIT）：双击 `下载词典.cmd` 自行下载。',
    '- **whisper 语音识别模型**（`models/ggml-*.bin`，数百 MB）：只有视频没有字幕、需要语音识别时才需要。',
    '',
    '这两样都不进包，是为了让发布包保持可下载；程序在没有它们时也能正常跑（英文词典缺失只是没有中文释义，模型缺失只是不能做语音识别）。',
    '',
  );
  putText('THIRD-PARTY-NOTICES.md', lines.join('\n'));
}

function zipUp(entriesToZip) {
  // 自己写 zip，不用 .NET 的 ZipFile.CreateFromDirectory：
  // 后者在 Windows 上把条目名写成 `node_modules\kuromoji\...`（反斜杠），
  // 这是违反 zip 规范的——Windows 资源管理器勉强能认，macOS / Linux 解出来
  // 会变成一堆名叫 `node_modules\kuromoji\...` 的单文件。zip 条目名必须用 `/`。
  const entries = entriesToZip.map((rel) => ({
    name: rel, // 收集时已经统一成正斜杠
    data: readFileSync(join(STAGING, rel.split('/').join(sep))),
  }));
  const buf = makeZip(entries);
  mkdirSync(dirname(ZIP), { recursive: true });
  writeFileSync(ZIP, buf);

  // 写完立刻读回来验：名字必须是正斜杠，条目数要对得上
  const back = readZip(buf);
  const names = [...back.keys()];
  const badSlash = names.filter((n) => n.includes('\\'));
  if (badSlash.length) throw new Error(`zip 里有 ${badSlash.length} 个反斜杠条目名，例如 ${badSlash[0]}`);
  if (names.length !== entries.length) throw new Error(`zip 条目数 ${names.length} ≠ ${entries.length}`);
  console.log(`  zip 回读校验：${names.length} 个条目，全部正斜杠，中文名可解`);
}

function sha256(file) {
  const h = createHash('sha256');
  h.update(readFileSync(file));
  return h.digest('hex');
}

// ── 主流程 ───────────────────────────────────────────────────────────
console.log('清空 staging…');
rmSync(STAGING, { recursive: true, force: true });
mkdirSync(STAGING, { recursive: true });

console.log('收集白名单文件…');
for (const d of DIRS) {
  walkCopy(join(ROOT, d), d, { skipDirs: ['node_modules', '.trash'] });
}
for (const f of ROOT_FILES) put(join(ROOT, f), f);
for (const f of TOOLS) put(join(ROOT, 'tools', f), join('tools', f));
for (const f of DATA_FILES) put(join(ROOT, 'data', f), join('data', f));
for (const [rel, text] of Object.entries(DATA_TEMPLATES)) putText(join('data', rel), text);
for (const f of FIXTURES) put(join(ROOT, 'test', 'fixtures', f), join('test', 'fixtures', f));

console.log('从锁定依赖装生产依赖…');
const versions = installProdDeps();
writeNotices(versions);

// ── staging 自检 ─────────────────────────────────────────────────────
console.log('staging 自检…');
const stagingFiles = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else stagingFiles.push(relative(STAGING, full).split(sep).join('/'));
  }
}(STAGING));

const bad = stagingFiles.filter((f) => FORBIDDEN.test(f));
const personal = stagingFiles.filter((f) => /^data\/wordlists\//i.test(f));
const totalBytes = stagingFiles.reduce((n, f) => n + statSync(join(STAGING, f)).size, 0);

console.log(`  文件 ${stagingFiles.length} 个，共 ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
if (bad.length) {
  console.error('  ✖ 命中禁令：');
  for (const f of bad) console.error('    ' + f);
  process.exit(1);
}
if (personal.length) {
  console.error('  ✖ 带上了个人词表：');
  for (const f of personal) console.error('    ' + f);
  process.exit(1);
}
console.log('  ✔ 没有 runs/models/samples/.git/词典/个人词表');

if (process.argv.includes('--no-zip')) {
  console.log('\n只做 staging（--no-zip），未打 zip。');
  process.exit(0);
}

console.log('打 zip…');
zipUp(stagingFiles);
const size = statSync(ZIP).size;
console.log('');
console.log(`发布包：${ZIP}`);
console.log(`大小：${(size / 1024 / 1024).toFixed(2)} MB（${size} 字节）`);
console.log(`SHA-256：${sha256(ZIP)}`);
console.log(`文件数：${stagingFiles.length}`);
