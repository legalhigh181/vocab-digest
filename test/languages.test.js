/**
 * T1：语言契约、词表隔离与英文兼容。
 *
 * 这些测试只验证「契约与接线」，不验证日语分词质量（那是 T3 的事）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { resolveConfig } from '../src/config.js';
import { normalizeLanguage, isSupportedLanguage, LANGUAGE_DEFAULTS, requireRuntime, clearRuntime } from '../src/languages/index.js';
import { prepareLanguageRuntime, RUNTIME_VERSION } from '../src/languages/runtime.js';
import { loadLexicon } from '../src/lexicon/lexicon.js';
import { ensureData } from '../src/data/seed.js';
import { prepareRuntime, runDigestAsync } from '../src/run.js';

// 中文路径下 new URL().pathname 是 URL 编码的，必须用 fileURLToPath
const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

let root;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'vocab-t1-'));
});
after(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

describe('语言契约', () => {
  it('缺省是 en', () => {
    assert.equal(normalizeLanguage(undefined), 'en');
    assert.equal(normalizeLanguage(null), 'en');
    assert.equal(normalizeLanguage(''), 'en');
  });

  it('接受 en / ja，jp 归一为 ja', () => {
    assert.equal(normalizeLanguage('en'), 'en');
    assert.equal(normalizeLanguage('ja'), 'ja');
    assert.equal(normalizeLanguage('jp'), 'ja');
    assert.equal(normalizeLanguage(' JA '), 'ja');
  });

  it('非法值抛 INVALID_LANGUAGE（不猜、不子串匹配）', () => {
    for (const bad of [true, 1, {}, [], 'fr', 'english', 'japanese', 'zh']) {
      assert.throws(() => normalizeLanguage(bad), (e) => e.code === 'INVALID_LANGUAGE', `${String(bad)} 应报错`);
    }
  });

  it('isSupportedLanguage 不抛错', () => {
    assert.equal(isSupportedLanguage('ja'), true);
    assert.equal(isSupportedLanguage('jp'), true);
    assert.equal(isSupportedLanguage('fr'), false);
    assert.equal(isSupportedLanguage(true), false);
  });
});

describe('配置：语言默认值', () => {
  it('英语 minLen=3，日语 minLen=1', () => {
    const en = resolveConfig({ cwd: root, language: 'en' });
    const ja = resolveConfig({ cwd: root, language: 'ja' });
    assert.equal(en.lexicon.minLen, 3);
    assert.equal(ja.lexicon.minLen, 1);
    assert.equal(ja.lexicon.minFreq, 1);
  });

  it('随包 config.default.json 里的英文默认不会被误当成用户配置', () => {
    // 日语必须拿到自己的路径，而不是掉回 data/stopword.txt
    const ja = resolveConfig({ cwd: root, language: 'ja' });
    assert.ok(ja.lexicon.stopwordFile.includes(`data${sep}ja`));
    assert.equal(ja.lexicon.posFile, '');
    assert.equal(ja.lexicon.baseFile, '');
  });

  it('用户显式覆盖优先于语言默认值', () => {
    const ja = resolveConfig({ cwd: root, language: 'ja', overrides: { lexicon: { minLen: 3 } } });
    assert.equal(ja.lexicon.minLen, 3);
    const en = resolveConfig({ cwd: root, overrides: { lexicon: { minFreq: 2 } } });
    assert.equal(en.lexicon.minFreq, 2);
  });

  it('language 非法时 resolveConfig 直接抛', () => {
    assert.throws(() => resolveConfig({ cwd: root, language: 'xx' }), (e) => e.code === 'INVALID_LANGUAGE');
  });

  it('配置里的 language 生效', () => {
    writeFileSync(join(root, 'cfg-ja.json'), JSON.stringify({ language: 'ja' }));
    const cfg = resolveConfig({ cwd: root, localConfigPath: join(root, 'cfg-ja.json') });
    assert.equal(cfg.language, 'ja');
    assert.equal(cfg.lexicon.minLen, 1);
  });
});

describe('数据目录：英日隔离', () => {
  it('ensureData(ja) 只建 data/ja/，不碰英文文件', () => {
    const dir = join(root, 'iso');
    const created = ensureData(dir, { language: 'ja' });
    assert.ok(created.length >= 2);
    assert.ok(existsSync(join(dir, 'ja', 'stopword.txt')));
    assert.ok(existsSync(join(dir, 'ja', 'known.txt')));
    // 英文那套一个都不该建
    assert.equal(existsSync(join(dir, 'stopword.txt')), false);
    assert.equal(existsSync(join(dir, 'pos.json')), false);
    assert.equal(existsSync(join(dir, 'base', 'base.txt')), false);
  });

  it('ensureData(en) 建英文骨架，不建日文目录', () => {
    const dir = join(root, 'iso-en');
    ensureData(dir, { language: 'en' });
    assert.ok(existsSync(join(dir, 'stopword.txt')));
    assert.ok(existsSync(join(dir, 'pos.json')));
    assert.equal(existsSync(join(dir, 'ja')), false);
  });

  it('ensureData 幂等：第二次不新建文件', () => {
    const dir = join(root, 'iso-idem');
    ensureData(dir, { language: 'en' });
    assert.deepEqual(ensureData(dir, { language: 'en' }), []);
  });
});

describe('词表加载：空路径不算缺文件', () => {
  it('日语配置下 base/pos/exceptions 为空也不报 missing', () => {
    const dir = join(root, 'lex-ja');
    ensureData(dir, { language: 'ja' });
    const cfg = resolveConfig({ cwd: dir, language: 'ja', dataDirOverride: dir });
    const lex = loadLexicon(cfg);
    assert.deepEqual(lex.missing, []);
    assert.equal(lex.language, 'ja');
    assert.ok(lex.stopwords.size > 0);
  });

  it('英语真缺文件时仍然报 missing（不许静默放行）', () => {
    const dir = join(root, 'lex-en-missing');
    mkdirSync(dir, { recursive: true });
    const cfg = resolveConfig({ cwd: dir, language: 'en', dataDirOverride: dir });
    const lex = loadLexicon(cfg);
    assert.ok(lex.missing.length > 0);
    assert.ok(lex.missing.some((m) => m.key === 'stopwordFile'));
  });
});

describe('运行时准备', () => {
  it('ja 运行时就绪，且不要求英文文件', async () => {
    const dir = join(root, 'rt-ja');
    ensureData(dir, { language: 'ja' });
    const cfg = resolveConfig({ cwd: dir, language: 'ja', dataDirOverride: dir });
    const rt = await prepareLanguageRuntime(cfg, { initData: false, resolveConfig: () => resolveConfig({ cwd: dir, language: 'ja', dataDirOverride: dir }) });
    assert.equal(rt.language, 'ja');
    assert.equal(rt.ready, true);
    assert.deepEqual(rt.missing, []);
    assert.equal(rt.runtimeVersion, RUNTIME_VERSION);
  });

  it('runDigestAsync：缺词表报 LEXICON_MISSING 而不是静默跑空', async () => {
    const dir = join(root, 'rt-missing');
    mkdirSync(dir, { recursive: true });
    await assert.rejects(
      () => runDigestAsync({ inputs: [join(FIXTURES, 'lecture.srt')], cwd: dir, dataDirOverride: dir, initData: false, language: 'en' }),
      (e) => e.code === 'LEXICON_MISSING',
    );
  });

  it('没准备运行时的时候同步调用会明确报 LANGUAGE_RUNTIME_NOT_READY', async () => {
    clearRuntime();
    assert.throws(() => requireRuntime('ja'), (e) => e.code === 'LANGUAGE_RUNTIME_NOT_READY');
    const dir = join(root, 'rt-notready');
    mkdirSync(dir, { recursive: true });
    await prepareRuntime({ cwd: dir, dataDirOverride: dir, language: 'ja' });
    assert.equal(requireRuntime('ja').ready, true);
  });
});

describe('英文兼容：跑一遍与旧行为一致', () => {
  it('英语 digest 落盘 schemaVersion=2 且 language=en，词条数不变', async () => {
    const dir = join(root, 'run-en');
    mkdirSync(dir, { recursive: true });
    const meta = await runDigestAsync({
      inputs: [join(FIXTURES, 'lecture.srt')], cwd: dir, dataDirOverride: dir, runId: 'compat-en', language: 'en',
    });
    assert.equal(meta.language, 'en');
    assert.equal(meta.schemaVersion, 2);
    const dig = JSON.parse(readFileSync(join(dir, 'runs', 'compat-en', 'digest.json'), 'utf8'));
    assert.equal(dig.language, 'en');
    assert.equal(dig.schemaVersion, 2);
    assert.ok(dig.items.length > 0, '英语应该抽出词条');
    // 旧结果没有 language 字段时按 en 读
    delete dig.language;
    assert.equal(dig.language ?? 'en', 'en');
  });

  it('日语 digest 能跑通，且不会因为缺英文词表而失败', async () => {
    const dir = join(root, 'run-ja');
    mkdirSync(dir, { recursive: true });
    const meta = await runDigestAsync({
      inputs: [join(FIXTURES, 'lecture.srt')], cwd: dir, dataDirOverride: dir, runId: 'compat-ja', language: 'ja',
    });
    assert.equal(meta.language, 'ja');
    const dig = JSON.parse(readFileSync(join(dir, 'runs', 'compat-ja', 'digest.json'), 'utf8'));
    assert.equal(dig.language, 'ja');
    assert.equal(dig.schemaVersion, 2);
  });
});

describe('LANGUAGE_DEFAULTS 自身一致性', () => {
  it('ja 的所有词表路径都为空或指向 data/ja/', () => {
    for (const [k, v] of Object.entries(LANGUAGE_DEFAULTS.ja)) {
      if (!k.endsWith('File')) continue;
      assert.ok(v === '' || v.startsWith('data/ja/'), `ja.${k} 不该是 ${v}`);
    }
  });

  it('en 的路径都指向 data/ 下（不是 data/ja/）', () => {
    for (const [k, v] of Object.entries(LANGUAGE_DEFAULTS.en)) {
      if (!k.endsWith('File') || !v) continue;
      assert.ok(v.startsWith('data/'), `en.${k} 应该是 data/...`);
      assert.equal(v.startsWith('data/ja/'), false, `en.${k} 不该指向 ja 目录`);
    }
  });
});
