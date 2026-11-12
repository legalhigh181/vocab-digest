/**
 * 真 whisper 转写探针（T6 待验收项「Whisper 真转写」）
 *
 * 只做两件事：
 *   1. checkWhisper()：这个 ffmpeg 有没有编入 whisper 滤镜、模型能不能真的加载；
 *   2. 指定 --transcribe 时，对一段真实音频跑一次 transcribe()，断言产物是带时间轴的 SRT。
 *
 * 用法：
 *   node tools/probe-real-whisper.mjs
 *   node tools/probe-real-whisper.mjs --transcribe samples/BV1Z7xh6HEfD.p1/audio.m4s --language zh --seconds 20
 *
 * 注意：真转写会占 GPU、几十秒到几分钟；本脚本不清理 samples/，产物落在 $TEMP 下。
 */
import { existsSync, mkdtempSync, renameSync, readFileSync, statSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { checkWhisper, transcribe, isEnglishOnlyModel } from '../src/asr.js';

const ROOT = resolve(import.meta.dirname, '..');
const MODEL = join(ROOT, 'models', 'ggml-small.bin');

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
}

const out = [];
const say = (line) => { out.push(line); console.log(line); };

// 1. ffmpeg 有没有 whisper 滤镜
const has = spawnSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8', windowsHide: true });
const hasFilter = Boolean(has.stdout && /whisper/i.test(has.stdout));
say(`ffmpeg 有 whisper 滤镜: ${hasFilter}（${has.stdout ? 'filters 可读' : String(has.error?.message ?? '读不到 filters')}）`);
say(`模型存在: ${existsSync(MODEL)}（${existsSync(MODEL) ? `${(statSync(MODEL).size / 1048576).toFixed(0)} MB` : '未找到'}）`);

// 2. 探针：模型能否加载（短音频 + 极短窗口，只验证滤镜能跑起来）
if (hasFilter && existsSync(MODEL)) {
  const probe = checkWhisper('ffmpeg', MODEL, { timeoutMs: 240000 });
  say(`checkWhisper: ok=${probe.ok} code=${probe.code ?? '-'} message=${probe.message}`);
}

// 3. 可选：真转写
const src = arg('transcribe', '');
if (src) {
  const language = arg('language', 'zh');
  const seconds = Number(arg('seconds', '20'));
  const work = mkdtempSync(join(tmpdir(), 'whisper-probe-'));
  const clip = join(work, 'clip.wav');
  const outSrt = join(work, 'out.srt');

  // 先裁一小段，别拿整首歌去跑（输出 wav：.m4s 这种扩展名 ffmpeg 认不出复用器）
  const cut = spawnSync('ffmpeg', ['-hide_banner', '-y', '-ss', '0', '-t', String(seconds), '-i', resolve(src), '-vn', '-ac', '1', '-ar', '16000', clip], {
    encoding: 'utf8', windowsHide: true,
  });
  say(`裁音频: exit=${cut.status} → ${clip}`);
  if (cut.status !== 0) {
    say(`裁音频失败：${(cut.stderr ?? '').split('\n').slice(-3).join(' | ')}`);
    process.exit(1);
  }

  const startedAt = Date.now();
  try {
    const r = await transcribe({
      input: clip,
      out: outSrt,
      model: MODEL,
      language,
      timeoutMs: 15 * 60_000,
      overwrite: true,
    });
    const text = readFileSync(outSrt, 'utf8');
    const cues = text.split(/\n\s*\n/).filter((b) => /-->/.test(b)).length;
    const head = text.split('\n').slice(0, 6).join(' / ');
    say(`transcribe: 成功（${r.bytes} 字节）用时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s 条目=${cues}`);
    say(`头几行: ${head}`);
    const showLines = Number(arg('show', '0'));
    if (showLines > 0) {
      say('--- SRT 正文（前若干条）---');
      say(text.split('\n').slice(0, showLines).join('\n'));
      say('--- SRT 正文结束 ---');
    }
    say(`结果是 SRT: ${/-->\s*\d{2}:\d{2}:\d{2}/.test(text)}`);
  } catch (e) {
    say(`transcribe 失败: code=${e.code ?? '-'} message=${e.message}`);
    if (e.stderr) say(`stderr 尾部: ${String(e.stderr).split('\n').slice(-4).join(' | ')}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

say(`英文专用模型判定（voice.en.bin）: ${isEnglishOnlyModel('ggml-voice.en.bin')}`);
const outName = arg('out', 'evidence-t6-real-whisper.txt');
const file = join(ROOT, 'docs', outName);
const { writeFileSync } = await import('node:fs');
writeFileSync(file, `${out.join('\n')}\n`, 'utf8');
console.log(`\n写入 ${file}`);
