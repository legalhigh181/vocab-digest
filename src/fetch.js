// 从视频到可分析的文本：字幕优先，没有字幕就走弹幕；两条都没有就转音频识别。
// 输出统一落到 samples/<bvid>.<page>/ 下，方便复核与重跑（不联网也能复现同一次 digest）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { audioUrl, DEFAULT_DANMAKU_CONCURRENCY, danmaku, download, parseBvid, subtitleBody, subtitleList, videoInfo } from './bili.js';
import { resolveModel, transcribe } from './asr.js';

/** 弹幕 → XML（与 parsers.js 的 parseDanmakuXml 兼容） */
export function danmakuToXml(items) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const body = items
    .map((d) => `  <d p="${Number(d.t).toFixed(2)},1,25,16777215,0,0,0,0">${esc(d.content)}</d>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<i>\n${body}\n</i>\n`;
}

/** 弹幕 → 纯文本（一句一行，给 txt 通道；去掉纯符号/纯数字） */
export function danmakuToText(items) {
  return items
    .map((d) => String(d.content).trim())
    .filter((s) => /[A-Za-z]/.test(s))
    .join('\n');
}

/**
 * 弹幕 → 带时间轴的 txt（`秒<TAB>内容`，parseTxtText 认得这个格式）。
 * 弹幕是「观众评论」而不是「台词」：它不能替代字幕，但能补出视频里出现的
 * 游戏名/作品名/流行语。单独存一份，默认不进 digest，用户想要再加。
 */
export function danmakuToTimedText(items) {
  return items
    .filter((d) => /[A-Za-z]/.test(String(d.content)))
    .map((d) => `${Number(d.t).toFixed(2)}\t${String(d.content).trim()}`)
    .join('\n');
}

function srtTime(sec) {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
}

export function linesToSrt(lines) {
  return `${lines
    .map((l, i) => `${i + 1}\n${srtTime(l.from)} --> ${srtTime(l.to || l.from + 2)}\n${l.content}\n`)
    .join('\n')}\n`;
}

/**
 * 取一个视频的字幕 / 弹幕 / （必要时）音频识别结果。
 *
 * 两个「抓」和两个「用」是分开的：
 *   fetchDanmaku（默认 true）  —— 要不要下载弹幕文件
 *   withDanmaku （默认 false） —— 下载到的弹幕要不要进 digest
 * 早期只有前者、后者被写死成「有台词就顺手交出去」，导致弹幕混进词频榜。
 *
 * @param {object} opts {
 *   link, cwd, outDir?, page?, fetchDanmaku?:boolean, withDanmaku?:boolean,
 *   asr?:boolean, model?, language?, concurrency?, log?
 * }
 */
export async function fetchVideo(opts = {}) {
  const log = opts.log ?? (() => {});
  const cwd = resolve(opts.cwd ?? process.cwd());
  const ref = parseBvid(opts.link);
  if (!ref.ok) return { ok: false, error: ref.error };

  const info = await videoInfo(ref);
  if (!info.ok) return { ok: false, error: `取视频信息失败：${info.error}` };

  const pages = info.info.pages ?? [];
  if (!pages.length) return { ok: false, error: '这个视频没有可用的分 P 信息', info: info.info };

  // 分 P 必须真实存在：早期找不到就静默退回第 1 P，用户以为抓的是 P2，其实拿到的是 P1
  const pageNo = Number(opts.page ?? ref.page ?? 1);
  if (!Number.isInteger(pageNo) || pageNo < 1) {
    return { ok: false, error: `分 P 号不合法：${opts.page ?? ref.page}（要从 1 开始）`, info: info.info };
  }
  const page = pages.find((p) => p.page === pageNo);
  if (!page) {
    return {
      ok: false,
      error: `这个视频没有第 ${pageNo} P（共 ${pages.length} P）`,
      info: info.info,
    };
  }
  const cid = page.cid;
  if (!cid) return { ok: false, error: `第 ${page.page} P 没有 cid，无法继续`, info: info.info };
  log(`《${info.info.title}》 ${info.info.owner} · ${page.duration}s · 第 ${page.page}/${pages.length} P`);

  const dir = resolve(opts.outDir ?? join(cwd, 'samples', `${info.info.bvid}.p${page.page}`));
  mkdirSync(dir, { recursive: true });
  const written = [];
  const write = (name, text) => {
    const f = join(dir, name);
    writeFileSync(f, text, 'utf8');
    written.push(f);
    return f;
  };

  const totalPages = pages.length;
  const paged = totalPages > 1;
  // 多 P 视频的跳转地址必须带 p，否则点时间戳会跳到第 1 P 的同一秒
  const playUrl = `https://www.bilibili.com/video/${info.info.bvid}${paged ? `?p=${page.page}` : ''}`;

  // 元数据独立落一份，句子的「跳到视频那一秒」全靠它（不依赖 digest 的字段拼装）
  const meta = {
    bvid: info.info.bvid,
    aid: info.info.aid,
    title: info.info.title,
    owner: info.info.owner,
    totalPages,
    page: page.page,
    pageTitle: page.title ?? '',
    cid,
    playUrl,
    fetchedAt: new Date().toISOString(),
    source: opts.link,
  };
  write('meta.json', `${JSON.stringify(meta, null, 2)}\n`);

  // 1) 字幕：有就优先用（最准，带时间轴）
  const sub = await subtitleList({ bvid: info.info.bvid, cid });
  let subtitleLines = null;
  if (sub.ok && sub.subtitles.length) {
    const pick =
      sub.subtitles.find((s) => (opts.language === 'ja' ? /ja|日本/.test(`${s.lan} ${s.lanDoc}`) : false))
      ?? sub.subtitles.find((s) => /en|English/.test(`${s.lan} ${s.lanDoc}`))
      ?? sub.subtitles[0];
    const body = await subtitleBody(pick.url);
    if (body.ok && body.lines.length) {
      subtitleLines = body.lines;
      write('subtitle.json', `${JSON.stringify(subtitleLines, null, 2)}\n`);
      write('subtitle.srt', linesToSrt(subtitleLines));
      log(`字幕：${subtitleLines.length} 条（${pick.lanDoc || pick.lan}${pick.ai ? ' · AI' : ''}）`);
    } else {
      log(`字幕：有字幕轨但下载失败（${body.error ?? '内容为空'}）`);
    }
  } else if (!sub.ok) {
    log(`字幕：查询失败（${sub.error}）`);
  } else {
    log('字幕：没有字幕轨');
  }

  // 2) 弹幕：抓与不抓由 fetchDanmaku 控制；失败要可见
  const wantDanmaku = opts.fetchDanmaku !== false;
  let dmCount = 0;
  let danmakuInfo = { requested: wantDanmaku, ok: false, count: 0, error: '', failed: [] };
  if (wantDanmaku) {
    const dm = await danmaku({
      cid,
      aid: info.info.aid,
      bvid: info.info.bvid,
      page: page.page,
      concurrency: opts.concurrency,
    });
    if (dm.ok) {
      dmCount = dm.count;
      danmakuInfo = {
        requested: true,
        ok: true,
        count: dm.count,
        error: '',
        segmentSize: dm.segmentSize,
        totalSegments: dm.total,
        fetchedSegments: dm.fetched,
        failed: dm.failed,
      };
      if (dm.count) {
        write('danmaku.xml', danmakuToXml(dm.items));
        write('danmaku.txt', `${danmakuToTimedText(dm.items)}\n`);
      }
      if (dm.failed.length) {
        // 部分分片失败：如实报出来，别装作完整
        log(`弹幕：${dm.count} 条，但 ${dm.failed.length}/${dm.total} 个分片下载失败（${dm.failed[0].error}）`);
        danmakuInfo.warning = `${dm.failed.length}/${dm.total} 个分片下载失败，弹幕可能不完整`;
      } else {
        log(`弹幕：${dm.count} 条（${dm.total} 片）`);
      }
    } else {
      danmakuInfo = {
        requested: true,
        ok: false,
        count: 0,
        error: dm.error,
        stage: dm.stage,
        failed: dm.failed ?? [],
      };
      log(`弹幕：获取失败（${dm.error}）`);
    }
  } else {
    log('弹幕：按要求跳过');
  }

  // 3) 没有字幕 → 下载音频走 whisper
  let asr = null;
  if (!subtitleLines && opts.asr !== false) {
    log('没有字幕，开始下载音频…');
    const au = await audioUrl({ bvid: info.info.bvid, cid });
    if (!au.ok) {
      return { ok: false, error: `取音频地址失败：${au.error}`, info: info.info, dir, written, danmaku: danmakuInfo };
    }
    // 音频文件名带分 P：多 P 视频各 P 的音频不一样，同名会互相覆盖
    const audioPath = join(dir, `audio.p${page.page}.m4s`);
    if (!existsSync(audioPath)) {
      const dl = await download(au.url, audioPath, {
        signal: opts.signal,
        onProgress: opts.onProgress,
        // 同一个第 N P 的音频只该下载一次：并发/重启后要重新下载必须显式允许覆盖。
        // 不给的话 download 会在 .part → 正式文件那一步报冲突，而不是悄悄盖掉。
        overwrite: opts.asrOverwrite === true,
      });
      if (!dl.ok) {
        return {
          ok: false,
          error: `下载音频失败：${dl.error}`,
          code: dl.code,
          info: info.info,
          dir,
          written,
          danmaku: danmakuInfo,
        };
      }
      log(`音频下载完成：${(dl.bytes / 1024 / 1024).toFixed(1)} MB`);
    }
    const model = resolveModel(cwd, opts.model);
    if (!model) {
      return { ok: false, error: '找不到 whisper 模型（models/ggml-small.bin），先下载模型或改用 --no-asr', dir, written };
    }
    // 字幕输出同样带分 P，且每次都是独立临时文件 + 原子落盘（见 asr.js），
    // 并发抓同一个视频的不同 P 不会互相覆盖，也不会把上一次的 srt 当成这次的结果
    const srtPath = join(dir, `audio.p${page.page}.srt`);
    try {
      const r = await transcribe({
        input: audioPath,
        out: srtPath,
        cwd,
        model,
        language: opts.language ?? 'en',
        signal: opts.signal,
        timeoutMs: opts.asrTimeoutMs,
        // 只有在明确要求覆盖时才允许替换上一次的同名字幕；默认冲突即失败
        overwrite: opts.asrOverwrite === true,
        onLog: log,
      });
      asr = { seconds: Math.round((r.elapsedMs ?? 0) / 1000), bytes: r.bytes ?? 0, file: srtPath };
    } catch (e) {
      return {
        ok: false,
        error: `语音识别失败：${e.message}`,
        code: e.code,
        stderr: e.stderr,
        info: info.info,
        dir,
        written,
        danmaku: danmakuInfo,
      };
    }
    written.push(srtPath);
    log(`语音识别完成：${asr.seconds}s（模型 ${model.split(/[\\/]/).pop()}）`);
  }

  // 4) 汇总「给 digest 用的文本」。
  // 台词（字幕/口播）是主料；弹幕只有 withDanmaku === true 才并进来。
  const transcriptFile = subtitleLines ? join(dir, 'subtitle.srt') : (asr?.file ? asr.file : null);
  const danmakuFileRaw = dmCount ? join(dir, 'danmaku.txt') : null;

  const inputs = [];
  if (transcriptFile) inputs.push(transcriptFile);
  if (danmakuFileRaw && opts.withDanmaku === true) inputs.push(danmakuFileRaw);

  if (!inputs.length) {
    if (!transcriptFile && danmakuFileRaw) {
      return {
        ok: false,
        error: '这个视频没有字幕也没有可识别的口播，只有弹幕。弹幕是观众评论、不是台词；确实要一起分析就打开「弹幕也一起分析」',
        info: info.info,
        dir,
        written,
        danmaku: danmakuInfo,
      };
    }
    if (!transcriptFile && wantDanmaku && !danmakuInfo.ok) {
      return {
        ok: false,
        error: `既没有字幕，弹幕也没取到（${danmakuInfo.error}）。这是取数失败，不是「零条弹幕」`,
        info: info.info,
        dir,
        written,
        danmaku: danmakuInfo,
      };
    }
    return {
      ok: false,
      error: '这个视频既没有字幕、也没有口播语音，也没有弹幕',
      info: info.info,
      dir,
      written,
      danmaku: danmakuInfo,
    };
  }

  const rel = (f) => f.replace(cwd, '').replace(/^[\\/]/, '');
  // 源文件标签带上「第 N P」：同一个视频抓了两 P 时，词条里能看出这句台词是哪一 P 的。
  // 注意只改展示用的标签，返回的 inputs 必须是**真实存在的路径**（早期版本把标签当路径返回，
  // 多 P 视频直接喂给 digest 就是「输入不存在」）。
  const tagify = (f) => (paged ? rel(f).replace(/(\.\w+)$/, `.p${page.page}$1`) : rel(f));

  return {
    ok: true,
    info: info.info,
    page: page.page,
    pageTitle: page.title ?? '',
    totalPages,
    cid,
    playUrl,
    dir,
    dirRel: rel(dir),
    metaFile: join(dir, 'meta.json'),
    subtitle: subtitleLines ? subtitleLines.length : 0,
    danmaku: dmCount,
    danmakuInfo,
    danmakuFile: danmakuFileRaw ? join(dir, 'danmaku.txt') : '',
    danmakuLabel: danmakuFileRaw ? tagify(danmakuFileRaw) : '',
    withDanmaku: opts.withDanmaku === true,
    asr,
    // 真实路径，能直接喂给 digest
    inputs: inputs.map((f) => f),
    inputsRel: inputs.map((f) => rel(f)),
    labels: inputs.map((f) => tagify(f)),
    written,
  };
}
