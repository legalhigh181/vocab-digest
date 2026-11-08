// 从视频到可分析的文本：字幕优先，没有字幕就走弹幕；两条都没有就转音频识别。
// 输出统一落到 samples/<bvid>.<page>/ 下，方便复核与重跑（不联网也能复现同一次 digest）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { audioUrl, danmaku, download, parseBvid, subtitleBody, subtitleList, videoInfo } from './bili.js';
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
 * @param {object} opts { link, cwd, outDir?, page?, danmaku?:boolean, asr?:boolean, model?, log? }
 */
export async function fetchVideo(opts = {}) {
  const log = opts.log ?? (() => {});
  const cwd = resolve(opts.cwd ?? process.cwd());
  const ref = parseBvid(opts.link);
  if (!ref.ok) return { ok: false, error: ref.error };

  const info = await videoInfo(ref);
  if (!info.ok) return { ok: false, error: `取视频信息失败：${info.error}` };
  const pageNo = Number(opts.page ?? ref.page ?? 1);
  const page = info.info.pages.find((p) => p.page === pageNo) ?? info.info.pages[0];
  const cid = page.cid;
  log(`《${info.info.title}》 ${info.info.owner} · ${page.duration}s · 第 ${page.page} P`);

  const dir = resolve(opts.outDir ?? join(cwd, 'samples', `${info.info.bvid}.p${page.page}`));
  mkdirSync(dir, { recursive: true });
  const written = [];
  const write = (name, text) => {
    const f = join(dir, name);
    writeFileSync(f, text, 'utf8');
    written.push(f);
    return f;
  };

  write(
    'meta.json',
    `${JSON.stringify(
      { ...info.info, page: page.page, cid, fetchedAt: new Date().toISOString(), source: opts.link },
      null,
      2,
    )}\n`,
  );

  // 1) 字幕：有就优先用（最准，带时间轴）
  const sub = await subtitleList({ bvid: info.info.bvid, cid });
  let subtitleLines = null;
  if (sub.ok && sub.subtitles.length) {
    const pick = sub.subtitles.find((s) => /en|English/.test(`${s.lan} ${s.lanDoc}`)) ?? sub.subtitles[0];
    const body = await subtitleBody(pick.url);
    if (body.ok && body.lines.length) {
      subtitleLines = body.lines;
      write('subtitle.json', `${JSON.stringify(subtitleLines, null, 2)}\n`);
      write('subtitle.srt', linesToSrt(subtitleLines));
      log(`字幕：${subtitleLines.length} 条（${pick.lanDoc || pick.lan}${pick.ai ? ' · AI' : ''}）`);
    }
  } else {
    log('字幕：没有字幕轨');
  }

  // 2) 弹幕
  let dmCount = 0;
  if (opts.danmaku !== false) {
    const dm = await danmaku({ cid, page: page.page, duration: page.duration });
    if (dm.ok) {
      dmCount = dm.count;
      if (dm.count) {
        write('danmaku.xml', danmakuToXml(dm.items));
        write('danmaku.txt', `${danmakuToTimedText(dm.items)}\n`);
      }
      log(`弹幕：${dm.count} 条`);
    } else {
      log(`弹幕：获取失败（${dm.error}）`);
    }
  }

  // 3) 没有字幕 → 下载音频走 whisper
  let asr = null;
  if (!subtitleLines && opts.asr !== false) {
    log('没有字幕，开始下载音频…');
    const au = await audioUrl({ bvid: info.info.bvid, cid });
    if (!au.ok) {
      return { ok: false, error: `取音频地址失败：${au.error}`, info: info.info, dir, written };
    }
    const audioPath = join(dir, 'audio.m4s');
    if (!existsSync(audioPath)) {
      const dl = await download(au.url, audioPath);
      if (!dl.ok) return { ok: false, error: `下载音频失败：${dl.error}`, info: info.info, dir, written };
      log(`音频下载完成：${(dl.bytes / 1024 / 1024).toFixed(1)} MB`);
    }
    const model = resolveModel(cwd, opts.model);
    if (!model) {
      return { ok: false, error: '找不到 whisper 模型（models/ggml-small.bin），先下载模型或改用 --no-asr', dir, written };
    }
    const srtPath = join(dir, 'audio.srt');
    const r = transcribe({ input: audioPath, out: srtPath, cwd, model, language: opts.language ?? 'en' });
    if (!r || r.status !== 0) {
      return { ok: false, error: `语音识别失败：${r?.error ?? '未知错误'}`, dir, written };
    }
    asr = { seconds: Math.round((r.elapsedMs ?? 0) / 1000), bytes: r.bytes };
    written.push(srtPath);
    log(`语音识别完成：${asr.seconds}s（模型 ${model.split(/[\\/]/).pop()}）`);
  }

  // 4) 汇总出「给 digest 用的文本」。
  // 字幕/口播是「台词」——词汇学习的主料；弹幕是观众评论，默认只保存不混进来，
  // 否则 rick / steam / pcl 这类游戏梗会把正经词汇挤掉。需要时加 --with-danmaku。
  const inputs = [];
  if (subtitleLines) inputs.push(join(dir, 'subtitle.srt'));
  else if (asr) inputs.push(join(dir, 'audio.srt'));
  // 关键：只有字幕轨的路径能接受 --with-danmaku 一起分析。走到语音识别说明原视频没有台词文本，
  // 此时弹幕就是用户想分析的内容，必须一起交出去，否则「只有弹幕的视频」会被直接判失败。
  if (subtitleLines || opts.withDanmaku) {
    if (dmCount) inputs.push(join(dir, 'danmaku.txt'));
  }

  if (!inputs.length) {
    const why = dmCount
      ? '这个视频没有字幕也没有口播语音（只有弹幕）。弹幕是观众评论，不是台词，需要时加 --with-danmaku 一起分析'
      : '这个视频既没有字幕、也没有弹幕，也没有可识别的音频口播';
    return { ok: false, error: why, info: info.info, dir, written };
  }

  const rel = (f) => f.replace(cwd, '').replace(/^[\\/]/, '');
  return {
    ok: true,
    info: info.info,
    page: page.page,
    cid,
    dir,
    dirRel: rel(dir),
    subtitle: subtitleLines ? subtitleLines.length : 0,
    danmaku: dmCount,
    danmakuFile: dmCount ? rel(join(dir, 'danmaku.txt')) : '',
    asr,
    inputs: inputs.map(rel),
    written,
  };
}
