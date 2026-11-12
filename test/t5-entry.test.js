/**
 * T5 · 入口贯通验收
 *
 * 用户点名的场景：
 *   - 各入口传递 language（CLI / Web API / 插件）
 *   - 非法语言拒绝
 *   - 旧记录默认英文
 *   - 跨语言词表拒绝
 *   - 重渲染使用原运行语言
 *   - 插件 schema 与实现一致
 *
 * 这里只测「不依赖网络、不依赖 kuromoji 也能跑」的部分；
 * 真正的日文分词由 ja*.test.js 覆盖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { normalizeLanguage, isSupportedLanguage, LANGUAGE_DEFAULTS } from '../src/languages/index.js';
import { WordlistStore } from '../src/wordlists/store.js';
import { renderRun, runDigest } from '../src/run.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const CLI = fileURLToPath(new URL('../bin/vocab-english.js', import.meta.url));
const ROOT = fileURLToPath(new URL('../', import.meta.url));

function tmp() {
  return mkdtempSync(join(tmpdir(), 't5-'));
}

/** 跑一次 CLI，返回 {code, stdout, stderr} */
function cli(argv, cwd) {
  const r = spawnSync(
    process.execPath,
    [CLI, ...argv],
    { cwd: cwd ?? ROOT, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } },
  );
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error ? `${r.error.code ?? ''} ${r.error.message}` : '' };
}

/**
 * 本机能不能 spawn 子进程。
 *
 * 在 DSH 的 Windows 沙箱里 spawnSync 会以 EPERM 失败、status 为 null，
 * 这时 CLI 这类「必须起子进程」的断言无从验证——记成环境受阻，不记成通过，
 * 也不记成代码失败。t.skip() 会把它打在报告里，方便在能起子进程的环境补跑。
 * 复现：node tools/probe-spawn.mjs
 */
const SPAWN_BLOCKED = /EPERM|EACCES/.test(cli(['--version']).error);
const BLOCKED_REASON = `本机沙箱拦子进程（EPERM），无法执行 CLI；复现见 tools/probe-spawn.mjs。手工替代证据见 docs/evidence-t6.md`;

// ── 入口：CLI ────────────────────────────────────────────────

test('T5 · CLI digest 传 --language ja 会写进 digest.json', (t) => {
  if (SPAWN_BLOCKED) return t.skip(BLOCKED_REASON);
  const dir = tmp();
  // runId 必须每次唯一：T6 起「显式 runId 已存在」默认报冲突（不覆盖别人的结果），
  // 用固定 id 会在第二次跑时撞上上一次留下的目录。
  const runId = `t5-cli-ja-${process.pid}-${Date.now().toString(36)}`;
  try {
    // 日文样例，走 ja 管线（需要 kuromoji；装了才跑）
    const hasKuromoji = (() => {
      try {
        // eslint-disable-next-line no-undef
        return Boolean(spawnSync(process.execPath, ['-e', "require.resolve('kuromoji')"], { cwd: ROOT }).status === 0);
      } catch { return false; }
    })();
    if (!hasKuromoji) {
      // 没装依赖时至少验证非法语言被拒（不依赖分词）
      const r = cli(['digest', join(FIXTURES, 'lecture.srt'), '--language', 'xx', '--run-id', 't5-bad']);
      assert.equal(r.code, 2, '非法语言必须退出码 2');
      assert.match(r.stdout + r.stderr, /不支持的语言/);
      return;
    }
    const r = cli(['digest', fileURLToPath(new URL('../samples/ja/demo.srt', import.meta.url)),
      '--language', 'ja', '--run-id', runId, '--json'], ROOT);
    assert.equal(r.code, 0, r.stderr);
    const dig = JSON.parse(readFileSync(join(ROOT, 'runs', runId, 'digest.json'), 'utf8'));
    assert.equal(dig.language, 'ja');
    assert.equal(dig.schemaVersion, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    // 清掉这次 CLI 在工程 runs/ 下留下的目录（runId 唯一，不会误删别人的）
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
  }
});

test('T5 · CLI 非法语言被拒绝，不会被悄悄当成英文', (t) => {
  if (SPAWN_BLOCKED) return t.skip(BLOCKED_REASON);
  for (const bad of ['xx', 'zh', 'jpn', 'EN_US', '123']) {
    const r = cli(['digest', join(FIXTURES, 'lecture.srt'), '--language', bad, '--run-id', 't5-bad']);
    assert.equal(r.code, 2, `--language ${bad} 必须失败，实际退出码 ${r.code}`);
    assert.match(r.stdout + r.stderr, /不支持的语言/, `--language ${bad} 的提示不对`);
  }
});

test('T5 · CLI 的 jp 是 ja 的别名', () => {
  assert.equal(normalizeLanguage('jp'), 'ja');
  assert.equal(normalizeLanguage('JA'), 'ja');
  assert.equal(normalizeLanguage(' en '), 'en');
});

test('T5 · 旧记录（没有 language 字段）按英文读', () => {
  const dir = tmp();
  try {
    const runDir = join(dir, 'legacy');
    mkdirSync(runDir, { recursive: true });
    // 模拟 T1 之前的 digest.json：没有 language、没有 schemaVersion
    writeFileSync(join(runDir, 'digest.json'), JSON.stringify({
      runId: 'legacy',
      sources: [{ name: 'x.srt', format: 'srt', count: 1 }],
      stats: { fileCount: 1, fragmentCount: 1, candidateCount: 1, keptCount: 1, filteredCount: 0 },
      sections: [{ key: 'pos:n.', label: '词性 · 名词', intro: '', items: [{
        word: 'doctor', display: 'doctor', count: 1, pos: 'n.', posLabel: '名词', meaning: '医生', samples: [], firstT: 0, sources: [], base: true,
      }] }],
      topWords: [], filtered: [],
    }, null, 2), 'utf8');
    const r = renderRun({ runDir });
    assert.equal(r.verify.ok, true, JSON.stringify(r.verify.checks.filter((c) => c.status !== 'pass')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T5 · 重渲染沿用运行自己的语言，不被当前配置覆盖', () => {
  const dir = tmp();
  try {
    const runDir = join(dir, 'ja-run');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'digest.json'), JSON.stringify({
      runId: 'ja-run',
      language: 'ja',
      schemaVersion: 2,
      sources: [{ name: 'x.srt', format: 'srt', count: 1 }],
      stats: { fileCount: 1, fragmentCount: 1, candidateCount: 1, keptCount: 1, filteredCount: 0 },
      sections: [{ key: 'pos:n.', label: '词性 · 名词', intro: '', items: [{
        word: '日本', display: '日本', count: 1, pos: 'prop.', posLabel: '专有名词', meaning: '日本',
        language: 'ja', entryKey: 'ja|日本|ニホン|prop.', reading: 'ニホン', readingHiragana: 'にほん',
        samples: [], firstT: 0, sources: [], base: false,
      }] }],
      topWords: [], filtered: [],
    }, null, 2), 'utf8');
    // T6 的负责人明确要求：显式语言与原运行冲突时必须拒绝，不能静默改成原语言、
    // 也不能回到「按调用方的语言排版」。拒绝之后 digest.json 一个字都不能变。
    const before = readFileSync(join(runDir, 'digest.json'), 'utf8');
    assert.throws(
      () => renderRun({ runDir, configOverrides: { language: 'en' } }),
      (e) => e.code === 'LANGUAGE_CONFLICT' && e.runLanguage === 'ja' && e.requestedLanguage === 'en',
      '日文运行用 en 重渲染必须报 LANGUAGE_CONFLICT',
    );
    assert.equal(readFileSync(join(runDir, 'digest.json'), 'utf8'), before, '被拒绝时不得改写原运行');
    assert.equal(existsSync(join(runDir, 'vocab.docx')), false, '被拒绝时不得产出文档');
    const ok = renderRun({ runDir, configOverrides: { language: 'ja' } });
    assert.equal(ok.verify.ok, true, JSON.stringify(ok.verify.checks.filter((c) => c.status !== 'pass')));
    assert.equal(ok.docModel.language, 'ja', '同语言重渲染必须落在 ja');
    assert.equal(ok.docModel.eastAsiaFont, 'Meiryo', '日文排版用 Meiryo');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 入口：词表跨语言 ────────────────────────────────────────

test('T5 · 跨语言词表：英文词条不会被当成日文、反之亦然', () => {
  const dir = tmp();
  try {
    const store = new WordlistStore(dir, { bootstrap: false });
    const en = store.create('英文表', { language: 'en' });
    const ja = store.create('日文表', { language: 'ja' });
    assert.equal(store.index().lists.find((l) => l.id === en.id).language, 'en');
    assert.equal(store.index().lists.find((l) => l.id === ja.id).language, 'ja');

    // 往英文表里塞日文词条：卡片层面允许，但词表语言不变
    store.addCards(en.id, [{ word: '日本', display: '日本', language: 'ja', kind: 'word', scene: [], tags: [], senses: [{ pos: 'prop.', meaning: '日本' }] }]);
    assert.equal(store.index().lists.find((l) => l.id === en.id).language, 'en', '词表语言不能被卡片的语言改掉');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 入口：语言默认值与词表隔离 ──────────────────────────────

test('T5 · 每种语言的最小词长不同，切换语言要跟着变', () => {
  assert.equal(LANGUAGE_DEFAULTS.en.minLen, 3);
  assert.equal(LANGUAGE_DEFAULTS.ja.minLen, 1, '日文必须允许一字实词');
  assert.notEqual(LANGUAGE_DEFAULTS.en.stopwordFile, LANGUAGE_DEFAULTS.ja.stopwordFile, '两种语言不能共用停用词表');
  assert.notEqual(LANGUAGE_DEFAULTS.en.knownFile, LANGUAGE_DEFAULTS.ja.knownFile);
});

test('T5 · 日文不加载英文专用资源（base/pos/exceptions 为空）', () => {
  assert.equal(LANGUAGE_DEFAULTS.ja.baseFile, '');
  assert.equal(LANGUAGE_DEFAULTS.ja.posFile, '');
  assert.equal(LANGUAGE_DEFAULTS.ja.lemmatizeExceptions, '');
});

// ── 插件 schema 与实现一致 ──────────────────────────────────

test('T5 · 插件输出 schema 里的 language 字段与实现一致', async () => {
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  // vocab_collect 的 output.properties 里必须有 language
  const block = src.slice(src.indexOf("name: 'vocab_collect'"));
  const schemaPart = block.slice(0, block.indexOf('async execute'));
  assert.match(schemaPart, /language: \{ type: 'string' \}/, 'vocab_collect 的 output schema 必须声明 language');
  assert.match(schemaPart, /required: \[[^\]]*'language'/, 'vocab_collect 的 required 必须包含 language');
  // 实现里确实返回了 meta.language
  assert.match(block, /language: meta\.language/);
});

test('T5 · 插件参数 schema 与 overridesOf 都支持 language', () => {
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(src, /if \(config\.language\) o\.language/, 'overridesOf 必须透传 config.language');
  const collect = src.slice(src.indexOf("name: 'vocab_collect'"));
  assert.match(collect.slice(0, collect.indexOf('async execute')), /language: \{ type: 'string'/, 'vocab_collect 参数要能传 language');
});
