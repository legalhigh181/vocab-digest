/**
 * 解析器集合：把各种弹幕 / 字幕文件归一成 Fragment。
 *
 * Fragment = { text, kind:'danmaku'|'subtitle', t?:number, src }
 *
 * 设计纪律：
 *   - 单个坏文件只记 warning，不让整批失败。
 *   - 所有解析器都是纯函数：吃文本字符串，吐 { fragments, warnings }。
 */
import { decodeEntities, toHalfWidth } from './util.js';

export const FRAGMENT_KINDS = ['danmaku', 'subtitle'];

/** 统一出口：规范化换行、去 BOM */
export function normalizeText(s) {
  return String(s ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

export function stripBom(s) {
  return String(s ?? '').replace(/^\uFEFF/, '');
}

function cleanText(s) {
  return toHalfWidth(s).replace(/\s+/g, ' ').trim();
}

// ── B 站字幕 JSON（body[].from/to/content；也兼容 start/text 风格） ──────
export function parseBilibiliSubtitleJson(raw, src) {
  const warnings = [];
  let obj;
  try { obj = JSON.parse(stripBom(raw)); } catch (e) {
    return { fragments: [], warnings: [{ level: 'error', message: `JSON 解析失败: ${e.message}` }] };
  }
  const body = Array.isArray(obj?.body) ? obj.body : Array.isArray(obj) ? obj : [];
  if (!body.length) warnings.push({ level: 'warn', message: '未找到 body[] 数组成员' });
  const fragments = [];
  for (const item of body) {
    if (!item || typeof item !== 'object') continue;
    const text = cleanText(item.content ?? item.text ?? '');
    if (!text) continue;
    const from = Number(item.from ?? item.start ?? NaN);
    fragments.push({ text, kind: 'subtitle', t: Number.isFinite(from) ? from : undefined, src });
  }
  return { fragments, warnings };
}

// ── B 站 / 通用弹幕 XML ─────────────────────────────────────────────────
export function parseDanmakuXml(raw, src) {
  const warnings = [];
  const text = decodeEntities(stripBom(raw));
  const frags = [];
  const re = /<(d|comment)\b([^>]*)>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(text))) {
    const attrs = m[2];
    const body = m[3];
    let p = '';
    const pa = /\bp="([^"]*)"/.exec(attrs);
    if (pa) p = pa[1];
    let t;
    if (p) {
      const n = Number(p.split(',')[0]);
      if (Number.isFinite(n)) t = n;
    }
    const bodyClean = body.replace(/<[^>]*>/g, '');
    const clean = cleanText(bodyClean);
    if (!clean) continue;
    frags.push({ text: clean, kind: 'danmaku', t, src });
  }
  if (!frags.length) warnings.push({ level: 'warn', message: '未匹配到 <d p="..."> 弹幕节点' });
  return { fragments: frags, warnings };
}

// ── 时间轴 ─────────────────────────────────────────────────────────────
const TIME_RE = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;
const TIME_RE_SHORT = /(\d{1,2}):(\d{2})[,.](\d{1,3})/;

function parseTimestamp(s) {
  let m = TIME_RE.exec(s);
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
  m = TIME_RE_SHORT.exec(s);
  if (m) return Number(m[1]) * 60 + Number(m[2]) + Number(m[3].padEnd(3, '0')) / 1000;
  return undefined;
}

// ── SRT ────────────────────────────────────────────────────────────────
export function parseSrt(raw, src) {
  const warnings = [];
  const blocks = normalizeText(raw).split(/\n\s*\n/);
  const frags = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim());
    if (!lines.length) continue;
    let idx = 0;
    if (/^\d+$/.test(lines[0].trim())) idx = 1;
    if (!lines[idx] || !lines[idx].includes('-->')) {
      warnings.push({ level: 'info', message: '跳过无时间轴的块' });
      continue;
    }
    const t = parseTimestamp(lines[idx]);
    const body = lines.slice(idx + 1).join(' ').replace(/<[^>]*>/g, '');
    const textClean = cleanText(body);
    if (!textClean) continue;
    frags.push({ text: textClean, kind: 'subtitle', t, src });
  }
  return { fragments: frags, warnings };
}

// ── WebVTT ─────────────────────────────────────────────────────────────
export function parseVtt(raw, src) {
  const warnings = [];
  let text = normalizeText(raw);
  if (!/^WEBVTT/.test(text)) warnings.push({ level: 'warn', message: '缺少 WEBVTT 头（仍尝试解析）' });
  text = text.replace(/^WEBVTT[^\n]*\n/, '');
  const blocks = text.split(/\n\s*\n/);
  const frags = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim());
    if (!lines.length) continue;
    if (/^(NOTE|STYLE|REGION)\b/.test(lines[0])) continue;
    const cueLine = lines.findIndex((l) => l.includes('-->'));
    if (cueLine < 0) continue;
    const t = parseTimestamp(lines[cueLine]);
    const body = lines.slice(cueLine + 1).join(' ').replace(/<[^>]*>/g, '');
    const textClean = cleanText(body);
    if (textClean) frags.push({ text: textClean, kind: 'subtitle', t, src });
  }
  return { fragments: frags, warnings };
}

// ── ASS / SSA ──────────────────────────────────────────────────────────
export function parseAss(raw, src) {
  const warnings = [];
  const lines = normalizeText(raw).split('\n');
  let inEvents = false;
  let formatCols = ['Layer', 'Start', 'End', 'Style', 'Name', 'MarginL', 'MarginR', 'MarginV', 'Effect', 'Text'];
  const frags = [];
  const parseAssTime = (s) => {
    const m = /(\d+):(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?/.exec(s);
    if (!m) return undefined;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number((m[4] ?? '0').padEnd(3, '0')) / 1000;
  };
  for (const line of lines) {
    const t = line.trim();
    if (/^\[Events\]/i.test(t)) { inEvents = true; continue; }
    if (/^\[/.test(t)) { inEvents = false; continue; }
    if (!inEvents) continue;
    const fmt = /^Format:\s*(.*)$/i.exec(t);
    if (fmt) { formatCols = fmt[1].split(',').map((s) => s.trim()); continue; }
    const dlg = /^Dialogue:\s*(.*)$/i.exec(t);
    if (!dlg) continue;
    // Text 通常是最后一列，内容里可能含逗号 —— 只切前 n-1 次
    const textIdx = formatCols.findIndex((c) => /^Text$/i.test(c));
    const cols = textIdx >= 0 ? textIdx : formatCols.length - 1;
    const parts = dlg[1].split(',');
    const head = parts.slice(0, Math.max(cols, 0));
    const body = parts.slice(Math.max(cols, 0)).join(',');
    const startIdx = formatCols.findIndex((c) => /^Start$/i.test(c));
    const tStart = startIdx >= 0 ? parseAssTime(head[startIdx] ?? '') : undefined;
    const bodyClean = body.replace(/\{[^}]*\}/g, ' ').replace(/\\N|\\n/gi, ' ');
    const textClean = cleanText(bodyClean);
    if (textClean) frags.push({ text: textClean, kind: 'subtitle', t: tStart, src });
  }
  if (!frags.length) warnings.push({ level: 'warn', message: 'Events 段未解析出 Dialogue' });
  return { fragments: frags, warnings };
}

// ── 通用 txt：每行一条弹幕 ───────────────────────────────────────────────
export function parseTxt(raw, src) {
  return parseTxtText(raw, src, 'danmaku');
}

/**
 * txt 解析可指定 kind：字幕 txt 更适合按行当片段（短句切分交给短语抽取）。
 */
export function parseTxtText(raw, src, kind = 'danmaku') {
  const warnings = [];
  const frags = [];
  for (const line of normalizeText(raw).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const m = /^(-?\d+(?:\.\d+)?)\s*[\t,]\s*(.+)$/.exec(t);
    const frag = m
      ? { text: cleanText(m[2]), kind, t: Number(m[1]) }
      : { text: cleanText(t), kind };
    if (!frag.text) continue;
    frags.push({ ...frag, src });
  }
  if (!frags.length) warnings.push({ level: 'warn', message: 'txt 中没有非空行' });
  return { fragments: frags, warnings };
}

/** 按扩展名分派解析器 */
export function parseByExt(ext, raw, src) {
  switch (String(ext).toLowerCase()) {
    case 'json': return parseBilibiliSubtitleJson(raw, src);
    case 'xml': return parseDanmakuXml(raw, src);
    case 'srt': return parseSrt(raw, src);
    case 'vtt': return parseVtt(raw, src);
    case 'ass': case 'ssa': return parseAss(raw, src);
    case 'txt': case 'tsv': return parseTxt(raw, src);
    default:
      return { fragments: [], warnings: [{ level: 'error', message: `未知扩展名 ${ext}` }] };
  }
}
