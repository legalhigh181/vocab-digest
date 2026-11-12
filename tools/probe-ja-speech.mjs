/**
 * 真实日语音频验收探针（m02395 第 1 项）
 *
 * 素材：samples/ja-audio/practice5.ogg / practice6.ogg
 *   Wikimedia Commons，Public Domain（作者 marsian，2006，native speaker）
 *   参考文本：https://en.wikibooks.org/wiki/Japanese/Pronunciation （Practice 节）
 *
 * 做四件事：
 *   1. 真 whisper 转写（language=ja，原语输出，不翻译）
 *   2. 打印 SRT 原文（人工对照用）
 *   3. 把 SRT 走 runDigestAsync 日文管线，打印词条（基本形/读音/词性/例句定位）
 *   4. 断言 offset 自洽：text.slice(start,end) === surfaceOriginal
 *
 * 用法：
 *   node tools/probe-ja-speech.mjs                     # 音频 5（モーラ鼻音 14 词）
 *   node tools/probe-ja-speech.mjs --set 6             # 音频 6（近音词对比）
 *   node tools/probe-ja-speech.mjs --file samples/ja-audio/practice5.ogg --run-id t7-ja-5
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkWhisper, transcribe } from '../src/asr.js';
import { runDigestAsync } from '../src/run.js';

const ROOT = resolve(import.meta.dirname, '..');
const MODEL = join(ROOT, 'models', 'ggml-small.bin');

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
}

const SET = String(arg('set', '5'));
const AUDIO = resolve(ROOT, arg('file', `samples/ja-audio/practice${SET}.ogg`));
const RUN_ID = String(arg('run-id', `t7-ja-audio-${SET}`));

const lines = [];
const say = (s = '') => { lines.push(s); console.log(s); };
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1;
  say(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` —— ${detail}` : ''}`);
};

// 参考词表（Wikibooks Practice 节，罗马字；供人工对照，不做自动判定）
const REFERENCE = {
  5: ['tenki 天気', 'renshuu 練習', 'zangyou 残業', 'anshin 安心', 'sunnari すんなり', 'denpa 電波',
    'senbei 煎餅', 'genmai 玄米', 'sen 千', 'hon 本', "sen'you 専用", "hon'ya 本屋", "san'en 三円", "tan'i 単位"],
  6: ['yuki 雪 / yuuki 勇気', 'soto 外 / souto 僧徒', 'soto 外 / sotou 粗糖', 'soto 外 / soutou 相当',
    'soto 外 / sotto そっと', 'sotto そっと / sottou 卒倒', 'maki 巻 / makki 末期', 'hako 箱 / hakkou 発行',
    'issei 一斉 / isei 異性', "tani 谷 / tan'i 単位", "san'en 三円 / sannen 三年",
    "kinyuu 記入 / kin'yuu 金融", "kinen 記念 / kin'en 禁煙"],
};

say(`素材: ${AUDIO}`);
check('音频存在', existsSync(AUDIO), existsSync(AUDIO) ? `${(statSync(AUDIO).size / 1024).toFixed(0)} KB` : '未找到');
if (!existsSync(AUDIO)) process.exit(1);

const probe = checkWhisper('ffmpeg', MODEL);
check('whisper 可用', probe.ok, `code=${probe.code ?? '-'} ${probe.message ?? ''}`);

say('');
say(`=== 参考词表（Wikibooks Practice ${SET}，人工对照用）===`);
for (const w of REFERENCE[SET] ?? []) say(`  · ${w}`);

const srtPath = join(ROOT, 'samples', 'ja-audio', `practice${SET}.srt`);
const reuse = process.argv.includes('--reuse');
const startedAt = Date.now();
let srt = '';
try {
  const r = reuse && existsSync(srtPath)
    ? { bytes: statSync(srtPath).size, gpu: null, reused: true }
    : await transcribe({ input: AUDIO, out: srtPath, model: MODEL, language: 'ja', timeoutMs: 20 * 60_000, overwrite: true });
  srt = readFileSync(srtPath, 'utf8');
  say('');
  say(`=== 转写结果（${r.bytes} 字节，${((Date.now() - startedAt) / 1000).toFixed(1)}s，GPU=${r.gpu ? '是' : '否'}）===`);
  say(srt.trim());
  check('转写有 SRT 时间轴', /-->\s*\d{2}:\d{2}:\d{2}/.test(srt));
  const cues = srt.split(/\n\s*\n/).filter((b) => /-->/.test(b));
  check('条目数 ≥ 5', cues.length >= 5, `${cues.length} 条`);
  // 原语输出：日文假名/汉字应占多数，不能是英文翻译
  const body = cues.map((b) => b.split('\n').slice(2).join(' ')).join(' ');
  const jaChars = (body.match(/[\u3040-\u30ff\u4e00-\u9fff]/g) ?? []).length;
  const latin = (body.match(/[A-Za-z]/g) ?? []).length;
  check('是日语原语输出（假名/汉字多于拉丁字母）', jaChars > latin, `假名汉字 ${jaChars} / 拉丁 ${latin}`);
  // 时间轴单调且不超音频时长
  const stamps = [...srt.matchAll(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->/g)]
    .map((m) => Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000);
  const mono = stamps.every((v, i) => i === 0 || v >= stamps[i - 1]);
  const durSec = 120;
  check('时间轴单调递增且不超音频', mono && stamps.at(-1) <= durSec + 5, `末条 ${stamps.at(-1)?.toFixed(2)}s`);
} catch (e) {
  say(`转写失败: code=${e.code ?? '-'} message=${e.message}`);
  if (e.stderr) say(`stderr 尾部: ${String(e.stderr).split('\n').slice(-5).join(' | ')}`);
  check('转写真跑成功', false, String(e.message));
  writeFileSync(join(ROOT, 'docs', 'evidence-t6-real-ja-speech.txt'), `${lines.join('\n')}\n`, 'utf8');
  process.exit(1);
}

// 走日文管线
say('');
say('=== 日文管线（基本形 / 读音 / 词性 / 例句定位）===');
const runDir = join(ROOT, 'runs', RUN_ID);
mkdirSync(join(ROOT, 'runs'), { recursive: true });
const digest = await runDigestAsync({
  inputs: [srtPath],
  language: 'ja',
  cwd: ROOT,
  runId: RUN_ID,
  overwrite: true,
  configOverrides: {},
});
const dig = JSON.parse(readFileSync(join(runDir, 'digest.json'), 'utf8'));
const items = dig.items ?? [];
say(`runId=${dig.runId ?? RUN_ID} 词条=${items.length} 片段=${dig.snippets?.length ?? '?'} 语言=${dig.language}`);

const rows = items.slice(0, 60).map((it) => {
  const reading = it.readingHiragana && it.readingHiragana !== it.reading ? `${it.reading}（${it.readingHiragana}）` : (it.reading || '—');
  const uk = it.unknown ? ' [未收录]' : '';
  const src = it.lemmaSource && it.lemmaSource !== 'surface' ? ` <${it.lemmaSource}>` : '';
  return `${it.display}  ${reading}  ${it.posDetail || it.pos || '?'}${uk}${src}  ×${it.count}`;
});
for (const r of rows) say(`  ${r}`);

// 例句定位自洽：usage 自带 text，直接在上面验
let checked = 0;
const bad = [];
for (const it of items) {
  for (const u of it.usages ?? []) {
    if (u.offsetExact === false || u.start == null || u.end == null) continue;
    if (typeof u.text !== 'string') continue;
    checked += 1;
    if (u.text.slice(u.start, u.end) !== u.surfaceOriginal) {
      bad.push(`${it.display} ${u.start}-${u.end} 期望「${u.surfaceOriginal}」实得「${u.text.slice(u.start, u.end)}」`);
    }
  }
}
check('例句 offset 自洽（text.slice(start,end) === surfaceOriginal）', bad.length === 0 && checked > 0, `检查 ${checked} 处${bad.length ? '，异常 ' + bad.slice(0, 3).join(' | ') : ''}`);
check('有基本形还原记录', items.some((it) => it.lemmaSource && it.lemmaSource !== 'surface'), items.filter((it) => it.lemmaSource && it.lemmaSource !== 'surface').slice(0, 6).map((it) => `${it.display}←${it.surface ?? ''}(${it.lemmaSource})`).join(' '));
check('有读音（片假名）', items.some((it) => /[\u30a0-\u30ff]/.test(it.reading ?? '')), items.filter((it) => /[\u30a0-\u30ff]/.test(it.reading ?? '')).length + ' 条');
check('Word 文档可渲染', Boolean(digest.docModel) && digest.docModel.language === 'ja', `title=${digest.docModel?.title}`);

say('');
say(failed === 0 ? '=== 全部通过 ===' : `=== ${failed} 项未通过 ===`);
writeFileSync(join(ROOT, 'docs', `evidence-t6-real-ja-speech${SET}.txt`), `${lines.join('\n')}\n`, 'utf8');
console.log(`\n写入 docs/evidence-t6-real-ja-speech${SET}.txt`);
process.exit(failed === 0 ? 0 : 1);
