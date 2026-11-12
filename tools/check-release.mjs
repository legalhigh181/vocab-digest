/**
 * 发布包干净环境自检：对着**解压出来的那一份**跑，不看开发机。
 *
 * 为什么单独写一个脚本而不是复用测试：测试跑的是源码树，这里要证明
 * 「一个只解了 zip 的目录，不碰开发机、不联网、不装依赖，也能跑通」。
 *
 * 用法：
 *   node tools/check-release.mjs "D:\临时\词汇库 解压测试\"
 *
 * 只做进程内调用（import 解压目录里的模块），不起子进程——
 * 受限环境里 Node 起子进程会被拦，那是环境限制，不该混进发布包的结论。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readZip } from '../src/docx/zip.js';

const DIR = resolve(process.argv[2] ?? '');
if (!process.argv[2] || !existsSync(DIR)) {
  console.error('用法：node tools/check-release.mjs <解压后的发布包目录>');
  process.exit(2);
}

const lines = [];
let bad = 0;
const ok = (msg) => lines.push(`  ✔ ${msg}`);
const no = (msg) => { bad += 1; lines.push(`  ✖ ${msg}`); };
const info = (msg) => lines.push(`    ${msg}`);

async function check(name, fn) {
  lines.push(`\n[${name}]`);
  try {
    await fn();
  } catch (e) {
    no(`${name} 抛异常：${e.message}`);
  }
}

/** 递归列文件（相对路径，正斜杠） */
function listFiles(dir, out = [], base = dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) listFiles(full, out, base);
    else out.push(relative(base, full).split(sep).join('/'));
  }
  return out;
}

const files = listFiles(DIR);
const has = (rel) => files.includes(rel);
const sizeOf = (rel) => statSync(join(DIR, rel)).size;

// 功能验证会往这份目录里写 runs/ 和默认词表，所以「不夹带个人数据」那几项
// 只对**刚解压出来**的副本有意义。跑过一遍的目录要重新解压再验。
const alreadyRun = files.some((f) => /^(runs|samples)\//.test(f) || /^data\/wordlists\//.test(f));
if (alreadyRun) {
  lines.push('⚠ 这份目录已经被跑过了（有 runs/ 或 data/wordlists/），结构检查结果不可信——请换一份全新解压的副本。');
}

// ── 1. 该有的都在 ─────────────────────────────────────────────────────
check('包内结构', () => {
  const need = [
    'package.json',
    'package-lock.json',
    'LICENSE',
    'THIRD-PARTY-NOTICES.md',
    'config.default.json',
    'bin/vocab-english.js',
    'src/index.js',
    'src/run.js',
    'src/asr.js',
    'src/ja/tokenizer.js',
    'app/public/app.html',
    'app/public/app.js',
    'app/public/app.css',
    'tools/install.vbs',
    'tools/download-dict.vbs',
    'data/base/base.txt',
    'data/ja/stopword.txt',
    'data/ja/meanings.json',
    'test/fixtures/lecture.srt',
    'node_modules/kuromoji/package.json',
    'node_modules/kuromoji/build/kuromoji.js',
  ];
  const missing = need.filter((r) => !has(r));
  if (missing.length) no(`缺文件：${missing.join('、')}`);
  else ok(`${need.length} 个关键文件齐全`);

  const dict = files.filter((f) => f.startsWith('node_modules/kuromoji/dict/'));
  if (dict.length < 10) no(`kuromoji 词典只有 ${dict.length} 个文件，应该 ≥10`);
  else ok(`kuromoji 词典 ${dict.length} 个文件，共 ${(dict.reduce((n, f) => n + sizeOf(f), 0) / 1024 / 1024).toFixed(2)} MB（解压即可离线分词）`);
});

// ── 2. 不该带的都没带 ─────────────────────────────────────────────────
check('不夹带个人数据', () => {
  const forbidden = [
    [/^runs\//i, '运行记录 runs/'],
    [/^versions\//i, 'UI 快照 versions/'],
    [/^models\//i, 'whisper 模型 models/'],
    [/^samples\//i, '真实视频样本 samples/'],
    [/^data\/wordlists\//i, '个人词表 data/wordlists/'],
    [/^data\/ecdict\.csv$/i, '英汉词典 ecdict.csv'],
    [/\.csv$/i, 'CSV'],
    [/ggml-.*\.bin$/i, 'whisper 权重'],
    [/\.part\d*$/i, '.part 临时文件'],
    [/\.bak\d*$/i, '.bak 备份'],
    [/cookies?/i, 'Cookie 文件'],
    [/^\.git\//i, 'git 仓库'],
    [/[-_]sheet\.png$/i, '设定原图'],
    [/(^|\/)\.asr-stage\//i, 'asr 暂存目录'],
    [/\.lock$/i, '锁文件'],
  ];
  const hit = [];
  for (const f of files) {
    for (const [re, why] of forbidden) if (re.test(f)) hit.push(`${f}（${why}）`);
  }
  if (hit.length) no(`带上了不该带的：\n      ${hit.slice(0, 20).join('\n      ')}`);
  else ok(`${files.length} 个文件里没有运行记录 / 个人词表 / 词典 / 模型 / Cookie / 临时文件`);

  const totalMB = files.reduce((n, f) => n + sizeOf(f), 0) / 1024 / 1024;
  info(`解压后共 ${totalMB.toFixed(2)} MB`);

  // zip 条目名用了反斜杠的话，macOS / Linux 解出来会是一堆名叫 `a\b\c` 的单文件
  const badNames = files.filter((f) => f.includes('\\'));
  if (badNames.length) no(`有 ${badNames.length} 个文件名带反斜杠（zip 条目名没转成正斜杠），例如 ${badNames[0]}`);
  else ok('文件名全部用正斜杠分隔（Windows / macOS / Linux 解压一致）');
});

// ── 3. 个人进度是空模板 ───────────────────────────────────────────────
check('个人进度为空模板', () => {
  for (const rel of ['data/known/known.txt', 'data/ja/known.txt']) {
    if (!has(rel)) { no(`缺 ${rel}`); continue; }
    const text = readFileSync(join(DIR, rel), 'utf8');
    const words = text.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
    if (words.length) no(`${rel} 带了 ${words.length} 个词（应该只有注释）：${words.slice(0, 5).join('、')}`);
    else ok(`${rel} 只有注释，没有个人进度`);
  }
});

// ── 4. 不依赖开发机路径 ───────────────────────────────────────────────
check('无开发机绝对路径', () => {
  const suspects = [/C:\\+Users\\+18169/i, /工作区 2/, /Documents\\+工作区/i];
  const scan = files.filter((f) => /^(src|bin|app|tools)\/.*\.(js|vbs|cmd|html|css|json|yml)$/.test(f)
    || /^(config\.default\.json|package\.json|cordis\.patch\.yml)$/.test(f));
  const hits = [];
  for (const f of scan) {
    const text = readFileSync(join(DIR, f), 'utf8');
    for (const re of suspects) {
      if (re.test(text)) hits.push(`${f} 命中 ${re}`);
    }
  }
  if (hits.length) no(`发现的绝对路径：\n      ${hits.join('\n      ')}`);
  else ok(`扫了 ${scan.length} 个文件，没有开发机绝对路径`);
});

// ── 5. 依赖闭包与锁定版本一致 ─────────────────────────────────────────
check('依赖与 lock 一致', () => {
  const pkg = JSON.parse(readFileSync(join(DIR, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(DIR, 'package-lock.json'), 'utf8'));
  const deps = Object.keys(pkg.dependencies ?? {});
  if (deps.length !== 1 || deps[0] !== 'kuromoji') no(`生产依赖应只有 kuromoji，实际 ${JSON.stringify(deps)}`);
  else ok('生产依赖只有 kuromoji@' + pkg.dependencies.kuromoji);

  const locked = new Map();
  for (const [k, v] of Object.entries(lock.packages ?? {})) {
    if (k.startsWith('node_modules/')) locked.set(k.slice('node_modules/'.length), v.version);
  }
  const want = [...locked.keys()].sort();
  const got = readdirSync(join(DIR, 'node_modules'), { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name).sort();
  if (want.join(',') !== got.join(',')) no(`node_modules 与 lock 不一致：lock=${want.join(',')} 包内=${got.join(',')}`);
  else ok(`${got.length} 个依赖包与 lock 完全一致`);

  for (const name of want) {
    const v = JSON.parse(readFileSync(join(DIR, 'node_modules', name, 'package.json'), 'utf8')).version;
    if (v !== locked.get(name)) no(`${name} 版本 ${v} ≠ lock ${locked.get(name)}`);
  }
  const notices = readFileSync(join(DIR, 'THIRD-PARTY-NOTICES.md'), 'utf8');
  const missingLic = want.filter((n) => !notices.includes(n));
  if (missingLic.length) no(`THIRD-PARTY-NOTICES 漏了：${missingLic.join(',')}`);
  else ok('第三方许可清单覆盖全部依赖');
  const licFiles = want.filter((n) => ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENSE-2.0.txt']
    .some((f) => existsSync(join(DIR, 'node_modules', n, f))));
  if (licFiles.length !== want.length) no(`这些包缺 LICENSE 原文：${want.filter((n) => !licFiles.includes(n)).join(',')}`);
  else ok('每个依赖包内都带许可证原文');
});

// ── 下面是功能验证 ───────────────────────────────────────────────────
const url = (rel) => pathToFileURL(join(DIR, rel)).href;

console.log(`发布包：${DIR}`);
console.log(`文件数：${files.length}`);

// —— 6. kuromoji 从包内词典离线分词 ——
const ja = { tokenizer: null, tokens: null };
check('离线分词（kuromoji 随包词典）', async () => {
  // 动态 import 解压目录里的 kuromoji：能加载就说明词典在包内、不需要联网。
  // 注意用包自己的 main（src/kuromoji.js，Node 版）——build/kuromoji.js 是浏览器版，
  // 一进去就要 XMLHttpRequest，跟「离线可用」无关。
  const main = JSON.parse(readFileSync(join(DIR, 'node_modules', 'kuromoji', 'package.json'), 'utf8')).main;
  const mod = await import(url(join('node_modules', 'kuromoji', main)));
  const kuro = mod.default ?? mod;
  // Node 版导出 { builder, dictionary, tokenizer }；CJS 互操作有时直接拿到 builder 本身
  const buildWith = typeof kuro === 'function' ? kuro : kuro.builder;
  ja.tokenizer = await new Promise((res, rej) => {
    buildWith({ dicPath: join(DIR, 'node_modules/kuromoji/dict') })
      .build((err, tk) => (err ? rej(err) : res(tk)));
  });
  ja.tokens = ja.tokenizer.tokenize('日本語を勉強しています');
  const surfaces = ja.tokens.map((t) => t.surface_form);
  const readings = ja.tokens.map((t) => t.reading ?? '').filter(Boolean);
  if (surfaces.length < 3) no(`分词只得到 ${surfaces.length} 个词`);
  else ok(`分词：${surfaces.join(' / ')}`);
  if (!readings.length) no('一个读音都没拿到');
  else ok(`读音：${readings.slice(0, 5).join(' / ')}`);
});

// 主流程在 async 里串起来（为了能 await import）
await (async () => {
  // —— 7. 英文 digest ——
  let enRun = null;
  await check('英文 digest', async () => {
    const { runDigest } = await import(url('src/run.js'));
    enRun = runDigest({
      inputs: [join(DIR, 'test', 'fixtures', 'lecture.srt')],
      cwd: DIR,
      runId: 'check-en',
    });
    const dig = JSON.parse(readFileSync(join(DIR, 'runs', 'check-en', 'digest.json'), 'utf8'));
    if ((dig.language ?? 'en') !== 'en') no(`digest.language 应为 en，实际 ${dig.language}`);
    else ok(`digest.language = ${dig.language ?? 'en（默认）'}`);
    const n = (dig.items ?? dig.entries ?? []).length;
    if (!n) no('一个词条都没抽出来');
    else ok(`抽出 ${n} 个词条（没有 ecdict.csv 也能跑，只是没有中文释义）`);
  });

  // —— 8. 日文 digest + 读音 ——
  let jaDig = null;
  await check('日文 digest + 读音', async () => {
    const srt = [
      '1',
      '00:00:00,000 --> 00:00:04,000',
      '日本語を勉強しています。',
      '',
      '2',
      '00:00:04,000 --> 00:00:08,000',
      '今日は新しい辞書を買いました。',
      '',
    ].join('\n');
    mkdirSync(join(DIR, 'samples', 'check'), { recursive: true });
    const srtPath = join(DIR, 'samples', 'check', 'ja.srt');
    writeFileSync(srtPath, srt, 'utf8');
    const { runDigestAsync } = await import(url('src/run.js'));
    // 输入路径按 process.cwd() 解析（不是 opts.cwd），所以这里一定是绝对路径
    await runDigestAsync({
      inputs: [srtPath],
      cwd: DIR,
      runId: 'check-ja',
      language: 'ja',
    });
    jaDig = JSON.parse(readFileSync(join(DIR, 'runs', 'check-ja', 'digest.json'), 'utf8'));
    if (jaDig.language !== 'ja') no(`digest.language 应为 ja，实际 ${jaDig.language}`);
    else ok('digest.language = ja');

    const entries = jaDig.items ?? jaDig.entries ?? [];
    if (!entries.length) { no('没有日文词条'); return; }
    const keysOk = entries.every((e) => String(e.entryKey ?? '').startsWith('ja|'));
    if (!keysOk) no('有词条的 entryKey 不是 ja| 开头');
    else ok(`${entries.length} 个词条，entryKey 全部以 ja| 开头`);
    const withReading = entries.filter((e) => e.reading);
    if (!withReading.length) no('没有词条带读音');
    else ok(`${withReading.length}/${entries.length} 个词条带片假名读音，例如 ${withReading[0].word} → ${withReading[0].reading}`);
    const withHira = entries.filter((e) => e.readingHiragana);
    if (!withHira.length) no('没有词条带平假名');
    else ok(`平假名也写了，例如 ${withHira[0].readingHiragana}`);
  });

  // —— 9. Word ——
  await check('Word 导出（日文排版）', async () => {
    if (!jaDig) { no('日文 digest 没跑成，跳过'); return; }
    const { renderRun } = await import(url('src/run.js'));
    const out = renderRun({ runDir: join(DIR, 'runs', 'check-ja'), cwd: DIR, decisions: {} });
    if (!existsSync(out.docxPath)) { no('没生成 docx'); return; }
    ok(`docx 已生成：${(statSync(out.docxPath).size / 1024).toFixed(0)} KB`);
    const zip = readZip(readFileSync(out.docxPath));
    const docBuf = zip.get('word/document.xml');
    if (!docBuf) { no('docx 里找不到 word/document.xml'); return; }
    const xml = docBuf.toString('utf8');
    if (!xml.includes('日语词汇整理')) no('标题不是「日语词汇整理」');
    else ok('标题前缀：日语词汇整理');
    if (!xml.includes('w:eastAsia="Meiryo"')) no('没有 w:eastAsia="Meiryo"');
    else ok(`w:eastAsia="Meiryo" 出现 ${(xml.match(/w:eastAsia="Meiryo"/g) ?? []).length} 次`);
    if (!/读音：/.test(xml)) no('词条行没有读音');
    else ok('词条行带「读音：」');
    if (/英语词汇整理/.test(xml)) no('混进了英文标题前缀');
    else ok('没有残留英文标题前缀');
    const stylesBuf = zip.get('word/styles.xml');
    const stylesXml = stylesBuf ? stylesBuf.toString('utf8') : '';
    if (!/w:eastAsia="ja-JP"/.test(stylesXml)) no('styles.xml 里缺 w:eastAsia="ja-JP"');
    else ok('默认语言标记 w:eastAsia="ja-JP"（styles.xml）');
  });

  // —— 10. 插件入口 ——
  await check('插件入口', async () => {
    const mod = await import(url('src/index.js'));
    const tools = [];
    const ctx = {
      get: (name) => (name === 'tools' ? { register: (t) => tools.push(t) } : undefined),
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      config: {},
    };
    await mod.apply(ctx, {});
    if (tools.length !== 9) no(`注册了 ${tools.length} 个工具，应为 9`);
    else ok(`注册 9 个工具：${tools.map((t) => t.name).join('、')}`);
    const build = tools.find((t) => t.name === 'vocab_build_docx');
    const lang = build?.parameters?.properties?.language;
    if (!lang || lang.type !== 'string' || (lang.enum ?? []).join(',') !== 'en,ja') no('vocab_build_docx 的 language 参数不对');
    else ok('vocab_build_docx.language = string enum[en,ja]');
    const collect = tools.find((t) => t.name === 'vocab_collect');
    if (!collect?.parameters?.properties?.language) no('vocab_collect 缺 language');
    else ok('vocab_collect 有 language');
  });

  // —— 11. 本地服务能起（不联网、不依赖开发机） ——
  await check('本地服务启动', async () => {
    const { startApp } = await import(url('src/app/server.js'));
    const app = await startApp({ cwd: DIR, port: 0 });
    const base = app.url.replace(/\/$/, '');
    const state = await (await fetch(`${base}/api/state`)).json();
    if (!state.ok) no('/api/state 没返回 ok');
    else ok(`服务起来了：${base}，词表 ${(state.lists ?? []).length} 个（语言 ${(state.lists ?? []).map((l) => l.language).join('/') || '无'}）`);
    const view = await (await fetch(`${base}/api/view?runId=check-ja`)).json();
    const items = (view.items ?? []);
    if (!items.length) no('/api/view 没给词条');
    else {
      const withReading = items.filter((i) => i.reading);
      if (!withReading.length) no('接口没把读音传给前端');
      else ok(`${items.length} 个词条，${withReading.length} 个带读音，${withReading[0].word} → ${withReading[0].reading}`);
      const leek = items.filter((i) => i.phonetic || i.dictMeaning || i.cambridge);
      if (leek.length) no(`日文条目漏了英文词典字段：${leek.length} 个`);
      else ok('日文条目不查英文字典');
    }
    const page = await (await fetch(`${base}/`)).text();
    if (!page.includes('语言') && !page.includes('langSel')) no('首页没找到语言选择入口');
    else ok('首页带语言选择入口');
    await new Promise((r) => app.server.close(r));
  });
})();

lines.push('');
lines.push(bad === 0 ? '结论：干净环境自检全部通过' : `结论：${bad} 项不通过`);
console.log(lines.join('\n'));
process.exitCode = bad === 0 ? 0 : 1;
