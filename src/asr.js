/**
 * 语音转写字幕：用 ffmpeg 内置的 whisper.cpp 滤镜。
 *
 * 为什么用 ffmpeg 而不是 python 的 whisper 包：
 *   本机 ffmpeg（含 libwhisper）直接带 whisper 滤镜，不需要额外装 Python 依赖，
 *   也不需要额外装 torch / ctranslate2。实测 598 秒的英语听力音频在 RTX 5070 上
 *   用 ggml-small 只要 145 秒（约 4× 实时），识别质量足够做词表统计。
 *
 * 用法：
 *   vocab-english transcribe <音频或视频> [--out x.srt] [--model ggml-small.bin]
 *                              [--language en] [--no-gpu]
 *
 * 产物是标准 srt，可以直接喂给 digest。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';

/**
 * 跑一个外部命令并拿到全部输出。
 *
 * 沙箱注意：这里的基线环境里 spawnSync 一旦带管道 / shell 就会 EPERM，
 * 而子进程的 stdio 只能是 'inherit' 或 'ignore'。所以这里把输出直接
 * 交给调用方（命令本身不依赖 stdout 也能完成工作），退出码用来判断成败。
 * 需要参数探测时用 checkWhisper()，它走「有没有 whisper 滤镜」的最少路径。
 */
function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, cwd ? { stdio: 'ignore', cwd } : { stdio: 'ignore' });
  return { status: r.status, error: r.error, stdout: '', stderr: '' };
}

/** 支持的模型档位：越大越准也越慢，small 是速度/质量平衡点 */
export const MODEL_TIERS = {
  'ggml-tiny.bin': '最快，准确度最低，只适合先试试流程',
  'ggml-base.bin': '快，口音重的素材容易错',
  'ggml-small.bin': '推荐。约 4× 实时，日常听力素材够用',
  'ggml-medium.bin': '更准，约 1.5× 实时，占 ~1.5GB 显存',
  'ggml-large-v3.bin': '最准，约 0.5× 实时，至少要 10GB 显存',
};

/**
 * ffmpeg 能不能做 whisper 转写。
 *
 * 这里不做「解析 -h filter=whisper 的帮助文本」：本沙箱拿不到子进程 stdout，
 * 而且真实用户环境里 ffmpeg 也可能只是旧版本。用一次 0.1 秒的静音探针，
 * 能跑通就是真的能用——比读帮助文本可靠。
 * @param {string} ffmpeg
 * @param {string} [model] 模型绝对路径（不传就只判断滤镜是否存在，跳过探针）
 */
export function checkWhisper(ffmpeg = 'ffmpeg', model = null, opts = {}) {
  const probe = spawnSync(ffmpeg, ['-hide_banner', '-h', 'filter=whisper'], { stdio: 'ignore' });
  if (probe.error) return { ok: false, message: `找不到 ffmpeg（${probe.error.message}）` };
  if (probe.status !== 0) {
    return { ok: false, message: '这个 ffmpeg 没有编入 whisper 滤镜，需要换成带 libwhisper 的构建' };
  }
  if (!model) return { ok: true, gpu: null, message: 'ffmpeg 带 whisper 滤镜' };
  // 探针必须在模型所在目录跑：ffmpeg 的滤镜参数里冒号和反斜杠都是分隔符，
  // Windows 绝对路径没法安全塞进去，用相对路径最稳
  const cwd = dirname(model);
  const rel = basename(model);
  const r = run(
    ffmpeg,
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono',
      '-t', '0.1',
      '-af', whisperFilter(rel, { language: 'en', format: 'text', gpu: opts.gpu }),
      '-f', 'null', '-',
    ],
    cwd,
  );
  if (r.status === 0) return { ok: true, gpu: true, message: 'ffmpeg 带 whisper 滤镜，探针转写通过' };
  return { ok: false, message: 'ffmpeg 有 whisper 滤镜但探针失败（模型或 GPU 不可用），用 --no-gpu 再试' };
}

/**
 * whisper 滤镜表达式（不含 -af 前缀，方便和别的滤镜串起来）。
 * use_gpu 只在明确关掉时才传：本机 ffmpeg 版本对 use_gpu=true 的短音频探针会失败，
 * 不传就自动走 GPU（实测 4× 实时）。
 */
function whisperFilter(model, { language = 'en', format = 'srt', destination = '', gpu = true } = {}) {
  const parts = [`model=${model.replace(/\\/g, '/')}`, `language=${language}`, `format=${format}`];
  if (destination) parts.push(`destination=${destination.replace(/\\/g, '/')}`);
  if (gpu === false) parts.push('use_gpu=false');
  return `whisper=${parts.join(':')}`;
}

/** 找模型文件：先看显式路径，再看 <cwd>/models/<name> */
export function resolveModel(cwd, modelName = 'ggml-small.bin') {
  if (!modelName) return null;
  if (existsSync(modelName)) return resolve(modelName);
  const p = join(cwd, 'models', basename(modelName));
  return existsSync(p) ? p : null;
}

const AUDIO_EXT = new Set(['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma']);
const VIDEO_EXT = new Set(['.mp4', '.mkv', '.flv', '.webm', '.mov', '.avi', '.m4s', '.ts']);

/**
 * 转写一个音视频文件成 srt。
 * @param {object} opts
 * @param {string} opts.input   音视频路径
 * @param {string} [opts.out]   输出 srt 路径（默认同目录同名 .srt）
 * @param {number} [opts.start] 起始秒数
 * @param {number} [opts.duration] 时长秒数（只转一段）
 * @param {string} [opts.language] 语言（默认 en）
 * @param {boolean} [opts.gpu] 是否用 GPU（默认 true）
 * @param {string} [opts.model] 模型绝对路径
 * @param {string} [opts.ffmpeg] ffmpeg 可执行名
 */
export function transcribe(opts = {}) {
  const input = resolve(opts.input ?? '');
  if (!existsSync(input)) {
    const err = new Error(`找不到输入文件：${input}`);
    err.code = 'INPUT_MISSING';
    throw err;
  }
  const ffmpeg = opts.ffmpeg ?? 'ffmpeg';
  const probe = checkWhisper(ffmpeg);
  if (!probe.ok) {
    const err = new Error(probe.message);
    err.code = 'WHISPER_UNAVAILABLE';
    throw err;
  }
  const modelName = opts.model ?? 'ggml-small.bin';
  // 探针必须在模型所在目录跑（滤镜参数含冒号和反斜杠，塞不进绝对路径），
  // 所以显式绝对路径只认，不再用 process.cwd() 去猜
  const model = resolveModel(opts.cwd ?? process.cwd(), modelName);
  if (!model) {
    const err = new Error(`找不到 whisper 模型：${modelName}（放到 models/ 下，或用 --model 指定绝对路径）`);
    err.code = 'MODEL_MISSING';
    err.missing = modelName;
    throw err;
  }

  const ext = extname(input).toLowerCase();
  const out = opts.out ? resolve(opts.out) : input.slice(0, -ext.length) + '.srt';
  mkdirSync(dirname(out), { recursive: true });
  // 在 models/ 目录里跑：滤镜参数用冒号分隔，绝对路径（尤其含空格和反斜杠）塞不进去
  const runCwd = dirname(model);
  const rel = (p) => relative(runCwd, p).replace(/\\/g, '/');

  const args = ['-y', '-hide_banner', '-loglevel', 'warning'];
  if (opts.start != null) args.push('-ss', String(opts.start));
  if (opts.duration != null) args.push('-t', String(opts.duration));
  args.push('-i', rel(input));
  // 视频文件按 dash 下载时常常没有音轨：ffmpeg 会直接报错，比默默生成空 srt 好
  const isVideo = VIDEO_EXT.has(ext) && !AUDIO_EXT.has(ext);
  const filters = [];
  if (isVideo) filters.push('aresample=16000');
  filters.push(
    whisperFilter(basename(model), {
      language: opts.language ?? 'en',
      format: 'srt',
      destination: rel(out),
      gpu: opts.gpu !== false,
    }),
  );
  args.push('-af', filters.join(','));
  // 滤镜只写文件，音频流本身没人要
  args.push('-f', 'null', '-');
  const started = Date.now();
  const r = run(ffmpeg, args, runCwd);
  const elapsedMs = Date.now() - started;
  // 本沙箱拿不到子进程输出，所以成败以「有没有产出 srt」为准，退出码只做辅助
  if (!existsSync(out) || statSync(out).size === 0) {
    const err = new Error('转写失败：ffmpeg 没有产出字幕（可能是音轨为空，或显存不够扛不住这个模型）');
    err.code = 'TRANSCRIBE_FAILED';
    err.status = r.status;
    throw err;
  }
  return {
    input,
    out,
    model,
    language: opts.language ?? 'en',
    gpu: opts.gpu !== false,
    bytes: statSync(out).size,
    elapsedMs,
    status: r.status,
  };
}
