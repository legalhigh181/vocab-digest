/**
 * 切词：从清洗后的文本里取出英文 token。
 *
 * 规则：
 *   - 拉丁词：[A-Za-z][A-Za-z'-]*，长度 ≥ minLen（默认 3），首尾撇号 / 连字符剥掉
 *   - 内部撇号保留（don't / it's → 交给缩略语拆分）
 *   - 全大写且 ≥2 字母 → 标记 isShout（刷屏 / 梗，默认丢弃）
 */

const TOKEN_RE = /[A-Za-z][A-Za-z'\u2019-]*/g;

export function tokenize(text, { minLen = 3 } = {}) {
  const out = [];
  if (!text) return out;
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(text))) {
    let raw = m[0].replace(/^['\u2019-]+|['\u2019-]+$/g, '');
    if (raw.length < minLen) continue;
    // 单词中间的连字符视为复合词，交给 splitCompound
    const lower = raw.toLowerCase().replace(/\u2019/g, "'");
    const isShout = raw.length >= 2 && raw === raw.toUpperCase() && /[A-Z]{2}/.test(raw);
    out.push({ raw, lower, isShout });
  }
  return out;
}

/** 撇号结尾的常见缩略：'s / 're / 've / 'll / 'd / 'm / 't */
export function splitContraction(token) {
  const m = /^([a-z]+)['\u2019](s|re|ve|ll|d|m|t)$/i.exec(token);
  if (m) return { stem: m[1], suffix: m[2].toLowerCase() };
  return null;
}

/** 驼峰 / 下划线 / 连字符拆词：keyBoard → [key, board]，well-known → [well, known] */
export function splitCompound(raw) {
  const parts = [];
  for (const piece of String(raw).split(/[-_]/)) {
    for (const c of piece.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/\s+/)) {
      if (c) parts.push(c);
    }
  }
  return parts;
}
