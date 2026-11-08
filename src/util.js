/**
 * 通用工具：稳定 JSON（可复现）、正则安全、文本规范化。
 */
import { createHash } from 'node:crypto';

/** 稳定序列化：对象键递归排序，保证同输入同输出 */
export function stableStringify(v) {
  return JSON.stringify(sortKeys(v));
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

/** 漂亮但稳定的 JSON（用于落盘，便于人工审阅） */
export function stablePretty(v) {
  return JSON.stringify(sortKeys(v), null, 2);
}

export function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

export function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** 全角 → 半角（ASCII 可打印区与全角空格） */
export function toHalfWidth(s) {
  return s
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeFromCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeFromCode(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => (name in ENTITIES ? ENTITIES[name] : m));
}

function safeFromCode(code) {
  try { return String.fromCodePoint(code); } catch { return ''; }
}

export function safeRegex(pattern) {
  if (!pattern) return null;
  try { return new RegExp(pattern, 'i'); } catch { return null; }
}

/** 秒 → mm:ss / h:mm:ss */
export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '';
  const t = Math.floor(sec);
  const s = String(t % 60).padStart(2, '0');
  const m = Math.floor(t / 60);
  if (m < 60) return `${String(m).padStart(2, '0')}:${s}`;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${s}`;
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}
