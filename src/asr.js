/**
 * 语音转写字幕：用 ffmpeg 内置的 whisper.cpp 滤镜。
 *
 * 为什么用 ffmpeg 而不是 python 的 whisper 包：
 *   本机 ffmpeg（含 libwhisper）直接带 whisper 滤镜，不需要额外装 Python 依赖，
 *   也不需要额外装 torch / ctranslate2。实测 598 秒的英语听力音频在 RTX 5070 上
 *   用 ggml-small 只要 145 秒（约 4× 实时），识别质量足够做词表统计。
 *
 * ── 子进程模型（T6 重做）───────────────────────────────────────────────
 * 转写动辄几分钟到几十分钟。以前用 spawnSync 同步阻塞：Web 服务和 DSH 插件在这段时间里
 * 完全没法响应（连探活请求都排队），前端看起来像卡死。现在全部改成异步 spawn：
 *
 *   - `transcribe()`         异步，返回 Promise；支持 signal 取消、超时、有界 stderr
 *   - `transcribeSync()`     同步包装，只给 CLI 用（CLI 本来就是一个前台进程）
 *   - `runFfmpeg()`          底层：异步子进程 + 超时 + 取消 + 有限 stderr + 清理
 *
 * 四条铁律：
 *   1. **绝不把旧字幕当成这次的成果**。旧文件从头到尾留在原位不动，新结果写在**本次唯一**的
 *      暂存文件里，等「退出码 + 产物存在 + 能解析出字幕」全部通过后才一次性提交替换。
 *      失败/取消/崩溃都不碰旧文件——它一直可用。
 *   2. **暂存目录和暂存文件名都必须唯一且安全**（见 `safeStageName`）。
 *   3. **同一输出路径不许被两个转写同时提交**：进程内占用表 + 落盘锁文件，抢不到就
 *      `OUTPUT_CONFLICT`。要覆盖已有的字幕，调用方必须显式传 `overwrite:true`。
 *   4. **错误必须带明确错误码**，调用方（Web/插件/CLI）据此给不同的处置建议，不要只给一句
 *      「转写失败」。错误码见 `ASR_ERRORS`。
 *
 * ── 为什么滤镜里不写用户的目标路径 ──────────────────────────────────────
 * ffmpeg 的滤镜参数是 `key=value` 冒号分隔的，路径里出现 `:`（Windows 盘符）或 `'`
 * （滤镜串里的引号）就会被吃进语法里；`relative()` 只能躲开盘符，躲不开引号。
 * 所以滤镜里的 destination 永远只是一个**纯 ASCII 的暂存文件名**，子进程工作目录设在
 * 模型所在目录，产物暂存在模型目录下的 `.asr-stage/`，转写成功再一次性提交到用户要的位置。
 * 用户那边的路径无论含中文、空格、单引号还是跨盘，都**完全不进 ffmpeg 的命令行与滤镜**。
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync,
  rmSync, statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

/** 所有转写失败的错误码。调用方按码给处置建议，不要靠字符串匹配。 */
export const ASR_ERRORS = {
  INPUT_MISSING: '输入文件不存在',
  INPUT_TOO_LARGE: '输入文件太大，超过本次上限',
  WHISPER_UNAVAILABLE: '这个 ffmpeg 没有编入 whisper 滤镜',
  FFMPEG_MISSING: '找不到 ffmpeg 可执行文件',
  MODEL_MISSING: '找不到 whisper 模型文件',
  MODEL_LANGUAGE_MISMATCH: '模型与转写语言不匹配（英语专用模型不能转日语）',
  INVALID_LANGUAGE: 'whisper 不支持这个语言代码',
  TRANSCRIBE_FAILED: 'ffmpeg 退出码非 0',
  TRANSCRIBE_TIMEOUT: '转写超时',
  TRANSCRIBE_CANCELLED: '转写被取消',
  TRANSCRIBE_NO_OUTPUT: 'ffmpeg 正常退出但没有产出字幕',
  TRANSCRIBE_EMPTY: '产出的字幕是空的（没有识别到任何一句）',
  TRANSCRIBE_STALE: '输出路径上存着旧字幕，本次没有产出新文件',
  OUTPUT_CONFLICT: '输出路径正被另一个转写占用，或已有字幕但没允许覆盖',
  FFMPEG_PATH_UNSAFE: '输入路径无法安全地传给 ffmpeg（含滤镜语法字符）',
  STAGE_UNWRITABLE: '暂存目录不可写，whisper 无法落盘中间字幕',
};

/** 默认 stderr 上限：ffmpeg 的警告行偶尔会刷很多，留 64KB 足够定位问题又不撑爆内存 */
export const DEFAULT_STDERR_LIMIT = 64 * 1024;

/** 暂存目录：放在模型目录下，保证和 whisper 滤镜写在同一个工作目录里 */
export const STAGE_DIRNAME = '.asr-stage';

/**
 * 转写时 ffmpeg 的 whisper 滤镜对语言的支持。
 *
 * `language=auto` 在 whisper 里是可用的（自动检测），但日文场景下 auto 会把夹着中文的
 * 素材识别成中文，所以这里仍然要求显式给语言；auto 只作为「用户明确要求」的选项保留。
 */
export const WHISPER_LANGUAGES = new Set([
  'auto', 'en', 'ja', 'zh', 'ko', 'es', 'fr', 'de', 'ru', 'pt', 'it',
]);

function asrError(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  err.messageZh = ASR_ERRORS[code] ?? message;
  Object.assign(err, extra);
  return err;
}

/** 把一个子进程的 stderr 收集起来，但最多留 limit 字节（超出部分丢弃并记账） */
function collectStderr(stream, limit = DEFAULT_STDERR_LIMIT) {
  const chunks = [];
  let kept = 0;
  let dropped = 0;
  stream?.setEncoding?.('utf8');
  stream?.on?.('data', (s) => {
    const buf = Buffer.from(String(s), 'utf8');
    if (kept >= limit) {
      dropped += buf.length;
      return;
    }
    const room = limit - kept;
    const take = buf.length <= room ? buf : buf.subarray(0, room);
    chunks.push(take);
    kept += take.length;
    if (take.length < buf.length) dropped += buf.length - take.length;
  });
  return {
    text: () => Buffer.concat(chunks).toString('utf8'),
    dropped: () => dropped,
  };
}

/**
 * 跑一个子进程，异步返回。**永远不 reject**：把失败原因放进返回值。
 *
 * 参数与 ffmpeg 无关，任何命令都能用——转写只需要「给命令、给参数、拿结果」。
 * 之所以不 reject：调用方要按「退出码/超时/取消/没能启动」分四种情况给不同的错误码，
 * 用 throw 表达这四种情况会丢掉行为信息。
 *
 * @returns {Promise<{status:number|null,signal:string|null,stderr:string,stderrDropped:number,
 *   timedOut:boolean,cancelled:boolean,elapsedMs:number,spawnError:Error|null}>}
 */
export function runFfmpeg(cmd, args, o = {}) {
  return new Promise((res) => {
    const started = Date.now();
    const limit = o.stderrLimit ?? DEFAULT_STDERR_LIMIT;
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: o.cwd,
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
        // detached 在 POSIX 下用来建进程组，killTree 可以整组杀
        detached: process.platform !== 'win32',
      });
    } catch (e) {
      res({
        status: null, signal: null, stderr: '', stderrDropped: 0,
        timedOut: false, cancelled: false, elapsedMs: Date.now() - started, spawnError: e,
      });
      return;
    }

    const err = collectStderr(child.stderr, limit);
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let timer = null;

    const onAbort = () => { cancelled = true; killTree(child); };
    if (o.signal) {
      if (o.signal.aborted) { cancelled = true; killTree(child); }
      else o.signal.addEventListener('abort', onAbort, { once: true });
    }
    if (o.timeoutMs && o.timeoutMs > 0) {
      timer = setTimeout(() => { timedOut = true; killTree(child); }, o.timeoutMs);
      timer.unref?.();
    }

    const finish = (status, signal, spawnError = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      o.signal?.removeEventListener?.('abort', onAbort);
      res({
        status, signal, spawnError,
        stderr: err.text(),
        stderrDropped: err.dropped(),
        timedOut, cancelled,
        elapsedMs: Date.now() - started,
      });
    };

    child.on('error', (e) => finish(null, null, e));
    child.on('close', (code, sig) => finish(code, sig));
  });
}

/**
 * 杀掉子进程及其子进程。
 *
 * Windows 下 ffmpeg 会派生子进程（whisper 的 GPU 后端），只 kill 父进程会留下孤儿占着显存，
 * 所以走 `taskkill /T`。POSIX 下因为 spawn 时开了 detached，子进程自成进程组，`-pid` 整组杀。
 */
function killTree(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
  } catch {
    try { child.kill('SIGKILL'); } catch { /* 进程已经没了 */ }
  }
}

/**
 * 探针：这个 ffmpeg 有没有 whisper 滤镜、模型能不能真的加载。
 *
 * 仍然用 spawnSync：它只在开工前跑一次，一两秒就结束，不构成阻塞风险。
 * 用异步反而会让「先探针后干活」的两段式错误处理更难写。
 */
export function checkWhisper(ffmpeg = 'ffmpeg', model = null, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const r = spawnSync(ffmpeg, ['-hide_banner', '-filters'], {
    encoding: 'utf8', windowsHide: true, timeout: 20_000, cwd,
  });
  if (r.error) {
    return { ok: false, code: 'FFMPEG_MISSING', message: `找不到 ffmpeg（${r.error.code ?? r.error.message}）` };
  }
  if (!/whisper/i.test(r.stdout ?? '')) {
    return {
      ok: false,
      code: 'WHISPER_UNAVAILABLE',
      message: '当前 ffmpeg 没有编译 whisper 滤镜，无法做语音识别；请换用带 libwhisper 的 ffmpeg',
    };
  }
  if (!model) return { ok: true, code: null, message: '有 whisper 滤镜' };

  // 探针也要往模型目录下的暂存区写 srt；不可写时 spawnSync 只会给一句含糊的失败，
  // 所以先探一次，把「权限问题」和「模型/GPU 问题」分开报。
  try {
    ensureWritableDir(resolve(dirname(model), STAGE_DIRNAME));
  } catch (e) {
    return { ok: false, code: e.code ?? 'STAGE_UNWRITABLE', message: e.message, hint: e.hint ?? null };
  }

  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '1'];
  const gpuFlag = opts.gpu === false ? 'use_gpu=false' : null;
  args.push('-af', `whisper=model=${basename(model)}:language=en:format=srt:destination=${probeDest()}`
    + (gpuFlag ? `:${gpuFlag}` : ''));
  args.push('-f', 'null', '-');
  const probe = spawnSync(ffmpeg, args, { cwd: dirname(model), encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  rmSync(join(dirname(model), probeDest()), { force: true });
  if (probe.status === 0) return { ok: true, code: null, message: 'whisper 可用' };
  return {
    ok: false,
    code: probe.status == null ? 'WHISPER_UNAVAILABLE' : 'TRANSCRIBE_FAILED',
    message: 'ffmpeg 有 whisper 滤镜但探针失败（模型或 GPU 不可用），用 --no-gpu 再试',
  };
}

/** 探针用的固定暂存文件名（ASCII，不会被滤镜语法吃掉） */
function probeDest() {
  return `${STAGE_DIRNAME}/probe.srt`;
}

/**
 * whisper 滤镜表达式（不含 -af 前缀，方便和别的滤镜串起来）。
 * use_gpu 只在明确关掉时才传：本机 ffmpeg 版本对 use_gpu=true 的短音频探针会失败，
 * 不传就自动走 GPU（实测 4× 实时）。
 */
function whisperFilter(model, { language = 'en', format = 'srt', destination = '', gpu = true } = {}) {
  const parts = [`model=${model.replace(/\\/g, '/')}`, `language=${language}`, `format=${format}`];
  if (destination) parts.push(`destination=${destination}`);
  if (gpu === false) parts.push('use_gpu=false');
  return `whisper=${parts.join(':')}`;
}

/**
 * 判断一个 whisper 模型名是不是「英语专用」。
 *
 * 依据是 whisper.cpp 的模型命名：`.en` 后缀（ggml-base.en.bin、ggml-small.en.bin…）
 * 表示英语专用多语种之外的英文单语模型；不带 `.en` 的是多语种模型，日语可用。
 * 只认后缀，不猜——名字里出现 "en" 但没带 .en 后缀的不算。
 */
export function isEnglishOnlyModel(modelName) {
  const base = String(modelName).split(/[\\/]/).pop() ?? '';
  return /\.en\.bin$/i.test(base);
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
 * 粗看一份 srt 里有没有真实字幕块。
 *
 * 判据是「有时间轴 + 至少一行非空文本」。空文件、只有一个 BOM、只有序号都不算成功——
 * whisper 在音轨全静音时确实会产出这种空壳文件，把它当成功会让整条流水线白跑。
 */
export function srtHasContent(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  if (!/-->\s*\d{2}:\d{2}:\d{2}/.test(text)) return false;
  return text.split(/\r?\n/).some((line) => line.trim() && !/^\d+$/.test(line.trim()) && !line.includes('-->'));
}

// ── 暂存与提交 ──────────────────────────────────────────────────────────

let seq = 0;
/** 进程号 + 时间 + 序号 + 随机，四段缺一都可能在并发下撞 */
function uniqueToken() {
  seq += 1;
  return `${process.pid}-${Date.now().toString(36)}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 暂存产物名：只含 [A-Za-z0-9._-]，滤镜语法里不可能被误读 */
export function safeStageName(token = uniqueToken()) {
  return `t_${String(token).replace(/[^A-Za-z0-9]/g, '_')}.srt`;
}

/**
 * 输入路径要不要放进 ffmpeg 的命令行。
 *
 * `-i` 是普通参数，不是滤镜，所以中文、空格、单引号都不怕（spawn 的 args 数组不经过 shell）。
 * 唯一怕的是能冒充「参数」的东西：以 `-` 开头的路径会被 ffmpeg 当成新选项。
 * 所以绝对路径可以，相对路径必须加 `./` 前缀，且不能以 `-` 起头。
 */
export function inputArg(p) {
  if (isAbsolute(p)) {
    if (/[\r\n\0]/.test(p)) {
      throw asrError('FFMPEG_PATH_UNSAFE', '输入路径里有换行符，无法安全传给 ffmpeg', { input: p });
    }
    return p;
  }
  if (p.startsWith('-')) {
    throw asrError('FFMPEG_PATH_UNSAFE', `输入文件名以 - 开头，会被 ffmpeg 当成选项：${p}`, { input: p });
  }
  return `./${p.replace(/\\/g, '/')}`;
}

/**
 * 确认暂存目录真的能写。
 *
 * 为什么要单独探一次：whisper 滤镜把中间字幕写在**子进程工作目录**下（见文件头），
 * 而工作目录固定在模型所在目录；模型常常被放在 Program Files、共享盘或只读镜像里，
 * 这时 ffmpeg 只报一句含糊的失败，用户根本看不出是权限问题。
 * 所以这里主动建目录 + 写一个探针文件 + 立刻删掉，不可写就在**起子进程之前**给出可操作错误。
 */
export function ensureWritableDir(dir) {
  const probe = join(dir, `.w-${process.pid}-${Date.now().toString(36)}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(probe, '');
    unlinkSync(probe);
  } catch (e) {
    try { rmSync(probe, { force: true }); } catch { /* 清不掉就算了 */ }
    throw asrError(
      'STAGE_UNWRITABLE',
      `暂存目录不可写：${dir}（${e.code ?? e.message}）`,
      {
        dir,
        cause: e.code ?? String(e.message),
        hint: [
          'whisper 滤镜必须把中间字幕写在这个目录里，所以模型目录需要有写权限。三选一：',
          '① 把 whisper 模型移到有写权限的目录（例如用户目录下），再用 --model 指向它；',
          '② 用 stageDir 指定一个暂存目录名（它会被建在模型目录下，所以仍要模型目录可写）；',
          '③ 给这个目录加写权限（只读镜像/共享盘上通常做不到，建议用 ①）。',
        ],
      },
    );
  }
  return dir;
}

/**
 * 正在提交的输出路径（进程内占用表），防止同进程两个转写同时往一个位置写。
 *
 * 必须在**转写一开始**就占上，而不是等产物验证完再去抢：
 * 两个任务同时往一个 srt 转写时，若只在提交前才互斥，两边都会白跑一遍（几分钟的 GPU 时间），
 * 最后后到的那边才发现冲突。先用「同一个目标只能有一个转写」把浪费挡在门口。
 */
const committing = new Map();
/** 当前进程已经持有的锁文件，退出时统一清掉 */
const heldLocks = new Set();

function lockPathOf(out) {
  return `${out}.lock`;
}

/**
 * 抢输出路径的提交权：先看进程内占用表，再抢落盘锁文件。
 * 锁文件里写持有者信息，方便卡死时人工排查。
 */
function claimOutput(out, tag) {
  const key = resolve(out);
  if (committing.has(key)) {
    throw asrError('OUTPUT_CONFLICT', `这个输出路径正由另一个转写占用：${out}`, { out, holder: tag });
  }
  const lock = lockPathOf(out);
  mkdirSync(dirname(out), { recursive: true });
  try {
    const fd = openSync(lock, 'wx');
    try { writeSync(fd, `${process.pid} ${tag} ${new Date().toISOString()}`); } finally { closeSync(fd); }
  } catch (e) {
    if (e.code === 'EEXIST') {
      throw asrError('OUTPUT_CONFLICT', `输出路径上有未清理的转写锁：${lock}（确认没有转写在跑后删掉它）`, {
        out, lock,
      });
    }
    throw asrError('OUTPUT_CONFLICT', `无法锁定输出路径：${out}（${e.code ?? e.message}）`, { out, lock });
  }
  committing.set(key, tag);
  heldLocks.add(lock);
  return () => {
    if (committing.get(key) === tag) committing.delete(key);
    heldLocks.delete(lock);
    try { unlinkSync(lock); } catch { /* 已经没了 */ }
  };
}

/** 进程退出时把没来得及释放的锁清掉（异常退出时最后的体面） */
process.on('exit', () => {
  for (const lock of heldLocks) {
    try { unlinkSync(lock); } catch { /* ignore */ }
  }
});

/**
 * 把暂存产物提交到目标位置。
 *
 * 先写到 `<out>.<token>.tmp`，`fsync` 之后再 `rename` 覆盖——同目录 rename 是原子的，
 * 中途崩溃不会留下半个文件；旧字幕在 rename 发生的**那一瞬间**才被替换。
 */
function commitOutput(staged, out) {
  const tmp = `${out}.${uniqueToken().replace(/[^A-Za-z0-9]/g, '_')}.tmp`;
  copyFileSync(staged, tmp);
  try {
    const fd = openSync(tmp, 'r+');
    try { writeSync(fd, ''); } catch { /* 某些文件系统 fsync 不支持，忽略 */ }
    closeSync(fd);
  } catch { /* ignore */ }
  renameSync(tmp, out);
}

/**
 * 异步转写一个音视频文件成 srt。
 *
 * @param {object} opts
 * @param {string} opts.input     音视频路径
 * @param {string} [opts.out]     输出 srt 路径（默认同目录同名 .srt）
 * @param {string} [opts.stageDir] 暂存目录名（相对模型目录，默认 .asr-stage）
 * @param {number} [opts.start]   起始秒数
 * @param {number} [opts.duration] 时长秒数（只转一段）
 * @param {string} [opts.language] 语言（默认 en）
 * @param {boolean} [opts.gpu]    是否用 GPU（默认 true）
 * @param {string} [opts.model]   模型绝对路径
 * @param {string} [opts.ffmpeg]  ffmpeg 可执行名
 * @param {number} [opts.timeoutMs] 超时（默认按 duration 估算，见下）
 * @param {AbortSignal} [opts.signal] 取消信号
 * @param {boolean} [opts.overwrite] 允许覆盖已存在的字幕（默认不允许，直接 OUTPUT_CONFLICT）
 * @param {number} [opts.stderrLimit]
 * @param {(s:string)=>void} [opts.onLog]
 * @returns {Promise<object>} 成功返回 {input,out,model,language,gpu,bytes,elapsedMs,status,...}
 */
export async function transcribe(opts = {}) {
  const log = opts.onLog ?? (() => {});
  const input = resolve(opts.input ?? '');
  if (!existsSync(input)) {
    throw asrError('INPUT_MISSING', `找不到输入文件：${input}`, { input });
  }
  const ffmpeg = opts.ffmpeg ?? 'ffmpeg';
  // 注入了可执行命令时跳过探针：探针跑的是真 ffmpeg，假命令没有 -filters 可言
  if (!opts.ffmpegCmd) {
    const probe = checkWhisper(ffmpeg);
    if (!probe.ok) {
      throw asrError(probe.code ?? 'WHISPER_UNAVAILABLE', probe.message, { ffmpeg });
    }
  }
  const modelName = opts.model ?? 'ggml-small.bin';
  const model = resolveModel(opts.cwd ?? process.cwd(), modelName);
  if (!model) {
    throw asrError(
      'MODEL_MISSING',
      `找不到 whisper 模型：${modelName}（放到 models/ 下，或用 --model 指定绝对路径）`,
      { missing: modelName },
    );
  }

  const language = String(opts.language ?? 'en');
  if (!WHISPER_LANGUAGES.has(language)) {
    throw asrError('INVALID_LANGUAGE', `whisper 不支持的语言代码：${language}`, { language });
  }
  // 日文词表不接受「英语专用模型」。
  // 依据不是名字猜的：真跑起来那类模型对日语基本只会吐英文幻觉，
  // 而 whisper-cli 对不匹配的模型根本不报错——静默产出垃圾才是最坏的情况。
  if (language === 'ja' && isEnglishOnlyModel(model)) {
    throw asrError(
      'MODEL_LANGUAGE_MISMATCH',
      `模型 ${basename(model)} 是英语专用模型，不能用于日语转写；请换用多语种模型（如 ggml-small.bin / ggml-medium.bin）`,
      { model, language },
    );
  }

  const ext = extname(input).toLowerCase();
  const out = opts.out ? resolve(opts.out) : input.slice(0, -ext.length) + '.srt';
  if (existsSync(out) && !opts.overwrite) {
    throw asrError('OUTPUT_CONFLICT', `目标字幕已存在，需要显式允许覆盖：${out}`, { out });
  }
  mkdirSync(dirname(out), { recursive: true });

  // 先把输出位置占上：同一个 srt 同时只允许一个转写在做。
  // 抢不到就直接失败，两边都不白跑；锁在 finally 里一定释放。
  const releaseClaim = claimOutput(out, `transcribe ${input}`);
  try {
    return await transcribeClaimed({ ...opts, input, out, model, language }, { log });
  } finally {
    releaseClaim();
  }
}

/** transcribe 的实体：输出位置已经被调用方占好，这里只管跑和提交 */
async function transcribeClaimed(opts, { log }) {
  // 2) 跑子进程（此时输出位置已被本调用独占）
  const r = await runTranscribeChild(opts, { log });
  // 3) 验收通过才提交——旧字幕在 rename 那一瞬间才被替换
  r.commit();
  const { commit, discard, ...result } = r;
  return result;
}

/**
 * 转写的核心：建暂存、跑子进程、按四条判定验收。
 * 抽出来是为了让「占位」的时机能独立于「跑多久」来控制。
 */
async function runTranscribeChild(opts, { log }) {
  const input = resolve(opts.input ?? '');
  const model = opts.model;
  const language = String(opts.language ?? 'en');
  const ffmpeg = opts.ffmpeg ?? 'ffmpeg';
  const out = opts.out;
  const ext = extname(input).toLowerCase();
  const runCwd = dirname(model);
  const stageRoot = resolve(runCwd, opts.stageDir ?? STAGE_DIRNAME);
  const token = uniqueToken();
  const stageName = opts.stageName ?? safeStageName(token);
  const stagePath = join(stageRoot, stageName);
  // ffmpeg 会不会自己建 destination 的父目录，各版本/平台并不一致（Linux 上常见
  // 「Could not open ...」）。暂存目录由我们自己建好，ffmpeg 只负责写文件。
  // 顺便先探一次可写性：模型目录常落在只读位置，早点报「不可写」比让 ffmpeg 含糊失败强。
  ensureWritableDir(stageRoot);
  if (existsSync(stagePath)) {
    throw asrError('OUTPUT_CONFLICT', `暂存文件名撞车（几乎不可能）：${stagePath}`, { stage: stagePath });
  }
  const stageRel = `${basename(stageRoot)}/${stageName}`;

  const args = ['-y', '-hide_banner', '-loglevel', 'warning'];
  if (opts.start != null) args.push('-ss', String(opts.start));
  if (opts.duration != null) args.push('-t', String(opts.duration));
  args.push('-i', inputArg(input));
  // 视频文件按 dash 下载时常常没有音轨：ffmpeg 会直接报错，比默默生成空 srt 好
  const isVideo = VIDEO_EXT.has(ext) && !AUDIO_EXT.has(ext);
  const filters = [];
  if (isVideo) filters.push('aresample=16000');
  filters.push(
    whisperFilter(basename(model), {
      language,
      format: 'srt',
      destination: stageRel,
      gpu: opts.gpu !== false,
    }),
  );
  args.push('-af', filters.join(','));
  // 滤镜只写文件，音频流本身没人要
  args.push('-f', 'null', '-');

  // 默认超时：音频时长未知时按 30 分钟兜底；给了 duration 就按 8 倍时长 + 2 分钟余量
  const timeoutMs = opts.timeoutMs ?? (
    opts.duration != null ? Math.round(Number(opts.duration) * 8_000) + 120_000 : 30 * 60_000
  );

  log(`转写：${basename(input)} → ${out}（语言 ${language}，模型 ${basename(model)}）`);
  // ffmpegCmd / ffmpegPreArgs 是给测试注入假 ffmpeg 的入口：把「假可执行」当成 node，
  // 脚本路径塞进参数最前面。生产调用永远走默认的 'ffmpeg'。
  const spawnCmd = opts.ffmpegCmd ?? ffmpeg;
  const spawnArgs = opts.ffmpegPreArgs ? [...opts.ffmpegPreArgs, ...args] : args;
  // 包一层的目标函数：既能替换子进程层（测试），也能走真 spawn
  const exec = opts.ffmpegTarget ?? ((cmd, a, o) => runFfmpeg(cmd, a, o));
  const r = await exec(spawnCmd, spawnArgs, {
    cwd: runCwd,
    timeoutMs,
    signal: opts.signal,
    stderrLimit: opts.stderrLimit,
  });

  const cleanup = () => rmSync(stagePath, { force: true });
  const fail = (code, msg, extra = {}) => {
    // 旧字幕从头到尾没被碰过，这里只清理自己的暂存文件
    cleanup();
    throw asrError(code, msg, {
      status: r.status,
      elapsedMs: r.elapsedMs,
      stderr: r.stderr.slice(-4000),
      stderrDropped: r.stderrDropped,
      ...extra,
    });
  };

  if (r.spawnError) {
    fail('FFMPEG_MISSING', `启动 ffmpeg 失败：${r.spawnError.message}`, { cause: r.spawnError });
  }
  if (r.cancelled) fail('TRANSCRIBE_CANCELLED', '转写被取消');
  if (r.timedOut) fail('TRANSCRIBE_TIMEOUT', `转写超时（${Math.round(timeoutMs / 1000)} 秒）`);
  if (r.status !== 0) {
    fail('TRANSCRIBE_FAILED', `转写失败：ffmpeg 退出码 ${r.status}${r.stderr ? `（${tailLine(r.stderr)}）` : ''}`);
  }
  // 退出码 0 还要看产物：whisper 可能「成功」跑完却一句没认出来
  if (!existsSync(stagePath)) {
    fail('TRANSCRIBE_NO_OUTPUT', '转写失败：ffmpeg 正常退出但没有产出字幕（音轨可能是空的）');
  }
  const size = statSync(stagePath).size;
  const produced = readFileSync(stagePath, 'utf8');
  if (!srtHasContent(produced)) {
    fail('TRANSCRIBE_EMPTY', '转写没有识别出任何一句（音轨可能是静音，或语言选错了）');
  }

  // 验收通过 → 交给调用方提交。
  // 提交是「占着输出位置、原子替换」那一步，必须在锁还没放掉的时候做，
  // 所以这里只把暂存产物交出去，由 transcribeClaimed 在锁内 commit。
  return {
    input,
    out,
    model,
    language,
    gpu: opts.gpu !== false,
    bytes: size,
    elapsedMs: r.elapsedMs,
    status: r.status,
    stderr: r.stderr,
    stderrDropped: r.stderrDropped,
    stage: stagePath,
    /**
     * 提交到 out。调用方必须还在锁里。
     * 旧文件在 rename 那一瞬间才被替换；没允许覆盖时，什么都不动直接抛冲突。
     */
    commit() {
      try {
        if (existsSync(out) && !opts.overwrite) {
          throw asrError('OUTPUT_CONFLICT', `目标字幕在转写期间被占用，需要显式允许覆盖：${out}`, { out });
        }
        commitOutput(stagePath, out);
      } finally {
        cleanup();
      }
    },
    /** 失败/放弃时丢掉暂存产物（旧文件不受影响） */
    discard: cleanup,
  };
}

/**
 * 测试/诊断用的可注入版本：用 opts.ffmpegTarget 指定的目标替代真 ffmpeg。
 *
 * 生产代码不要调它——真 ffmpeg 才是唯一想跑的东西。它存在的理由是：
 * 转写的正确性主要靠「退出码 + 产物 + 暂存目录 + 旧文件不动」这套契约，
 * 而契约必须能在没有 GPU、没有模型、没有 ffmpeg 的机器上验证。
 *
 * 三种注入方式（按优先级）：
 *   1. `ffmpegTarget`    任意符合 `runFfmpeg` 契约的异步函数，直接替换子进程层
 *                        （子进程被沙箱拦掉时，用它验证 transcribe 的全部判定逻辑）
 *   2. `ffmpegCmd/ffmpegPreArgs` 真的 spawn 一个假可执行（验证子进程层本身）
 *   3. 什么都不传       真的 ffmpeg
 */
export function transcribeWithCommand(opts = {}) {
  return transcribe(opts);
}

/** 取 stderr 里最后一条有内容的行，用来给失败信息点睛 */
function tailLine(s) {
  const lines = String(s).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return (lines[lines.length - 1] ?? '').slice(0, 200);
}

/**
 * 同步包装：只给 CLI 用。
 *
 * CLI 本身是一个前台进程，阻塞它没有副作用（反而能让 Ctrl+C 的行为跟以前一致）。
 * 这里用 spawnSync 重跑一条独立的路径，而不是在 transcribe 外面套 deasync 之类的桥——
 * 那种桥在 Node 里不可靠，而且会让错误栈变得没法读。
 *
 * 与异步版的四个判定、暂存、提交策略保持一致；唯一的差别是超时用 spawnSync 自带的。
 */
export function transcribeSync(opts = {}) {
  const input = resolve(opts.input ?? '');
  if (!existsSync(input)) throw asrError('INPUT_MISSING', `找不到输入文件：${input}`, { input });
  const ffmpeg = opts.ffmpeg ?? 'ffmpeg';
  if (!opts.ffmpegCmd) {
    const probe = checkWhisper(ffmpeg);
    if (!probe.ok) throw asrError(probe.code ?? 'WHISPER_UNAVAILABLE', probe.message, { ffmpeg });
  }
  const modelName = opts.model ?? 'ggml-small.bin';
  const model = resolveModel(opts.cwd ?? process.cwd(), modelName);
  if (!model) {
    throw asrError('MODEL_MISSING', `找不到 whisper 模型：${modelName}`, { missing: modelName });
  }
  const language = String(opts.language ?? 'en');
  if (!WHISPER_LANGUAGES.has(language)) {
    throw asrError('INVALID_LANGUAGE', `whisper 不支持的语言代码：${language}`, { language });
  }
  // 同 transcribe：CLI 这条路径也不能拿英语专用模型去转日语
  if (language === 'ja' && isEnglishOnlyModel(model)) {
    throw asrError(
      'MODEL_LANGUAGE_MISMATCH',
      `模型 ${basename(model)} 是英语专用模型，不能用于日语转写；请换用多语种模型`,
      { model, language },
    );
  }
  const ext = extname(input).toLowerCase();
  const out = opts.out ? resolve(opts.out) : input.slice(0, -ext.length) + '.srt';
  if (existsSync(out) && !opts.overwrite) {
    throw asrError('OUTPUT_CONFLICT', `目标字幕已存在，需要显式允许覆盖：${out}`, { out });
  }
  mkdirSync(dirname(out), { recursive: true });

  // 同步版同样「一开始就占位」：否则两个进程会各自白跑整段转写，最后才发现撞车。
  const release = claimOutput(out, `transcribe --sync ${input}`);
  try {
    return transcribeSyncClaimed(opts, { input, out, model, language, ffmpeg, ext });
  } finally {
    release();
  }
}

/** transcribeSync 的实体：输出位置已由调用方占好，这里只管跑和提交 */
function transcribeSyncClaimed(opts, { input, out, model, language, ffmpeg, ext }) {
  // 暂存区必须和子进程工作目录同级：滤镜 destination 是相对路径，
  // 相对的是子进程 cwd（模型所在目录），不是我们的进程 cwd。
  const runCwd = dirname(model);
  const stageRoot = resolve(runCwd, opts.stageDir ?? STAGE_DIRNAME);
  const token = uniqueToken();
  const stageName = opts.stageName ?? safeStageName(token);
  const stagePath = join(stageRoot, stageName);
  ensureWritableDir(stageRoot);
  const stageRel = `${basename(stageRoot)}/${stageName}`;

  const args = ['-y', '-hide_banner', '-loglevel', 'warning'];
  if (opts.start != null) args.push('-ss', String(opts.start));
  if (opts.duration != null) args.push('-t', String(opts.duration));
  args.push('-i', inputArg(input));
  const isVideo = VIDEO_EXT.has(ext) && !AUDIO_EXT.has(ext);
  const filters = isVideo ? ['aresample=16000'] : [];
  filters.push(whisperFilter(basename(model), {
    language, format: 'srt', destination: stageRel, gpu: opts.gpu !== false,
  }));
  args.push('-af', filters.join(','), '-f', 'null', '-');

  const spawnCmd = opts.ffmpegCmd ?? ffmpeg;
  const spawnArgs = opts.ffmpegPreArgs ? [...opts.ffmpegPreArgs, ...args] : args;
  const timeoutMs = opts.timeoutMs ?? (
    opts.duration != null ? Math.round(Number(opts.duration) * 8_000) + 120_000 : 30 * 60_000
  );
  const started = Date.now();
  const r = spawnSync(spawnCmd, spawnArgs, {
    cwd: runCwd, stdio: 'ignore', windowsHide: true, timeout: timeoutMs,
  });
  const elapsedMs = Date.now() - started;
  const cleanup = () => rmSync(stagePath, { force: true });
  if (r.error) {
    cleanup();
    throw asrError('FFMPEG_MISSING', `启动 ffmpeg 失败：${r.error.message}`, { cause: r.error });
  }
  if (r.status !== 0 || !existsSync(stagePath)) {
    const timedOut = r.signal === 'SIGTERM' || r.signal === 'SIGKILL';
    cleanup();
    throw asrError(
      timedOut ? 'TRANSCRIBE_TIMEOUT' : 'TRANSCRIBE_FAILED',
      `转写失败：ffmpeg 退出码 ${r.status ?? '?'}（可能是音轨为空，或显存不够扛不住这个模型）`,
      { status: r.status, elapsedMs },
    );
  }
  const size = statSync(stagePath).size;
  const produced = readFileSync(stagePath, 'utf8');
  if (!srtHasContent(produced)) {
    cleanup();
    throw asrError('TRANSCRIBE_EMPTY', '转写没有识别出任何一句（音轨可能是静音，或语言选错了）', { elapsedMs });
  }
  try {
    commitOutput(stagePath, out);
  } finally {
    cleanup();
  }
  return {
    input, out, model, language, gpu: opts.gpu !== false, bytes: size, elapsedMs, status: r.status,
  };
}
