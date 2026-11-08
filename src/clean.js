/**
 * 文本清洗：把一条弹幕 / 字幕变成「可切词的纯文本」。
 *
 * 目标：去掉 URL、QQ 群号、@ 提及、话题标签、纯符号、HTML 实体残留、重复刷屏字符。
 * 保留：英文单词、数字间的空格、常见标点（切句用）。
 */
import { decodeEntities, toHalfWidth } from './util.js';

const URL_RE = /https?:\/\/\S+|www\.\S+|BV[0-9A-Za-z]{10}/gi;
const MENTION_RE = /@[\w\u4e00-\u9fa5-]{1,20}/g;
const HASHTAG_RE = /#\s*[^#\s]{1,20}\s*#?/g;
const HTML_TAG_RE = /<[^>]*>/g;
const QQGROUP_RE = /\b[qQ]{2}\s*(?:群|group)?\s*[:：]?\s*\d{5,}\b/g;

/** 重复字符压缩：hhhh → hh，!!! → !!，同时保留 2 个上限 */
export function squashRepeats(s) {
  return s.replace(/(\w)\1{3,}/g, '$1$1').replace(/([!?.,~^])\1{2,}/g, '$1$1');
}

/**
 * 舞台提示 / 非语言标注：
 *   (gentle music)  [Music]  *laughs*  ♪♪
 * 字幕和弹幕里这些不是「说的话」，统计词汇时必须整段丢掉 ——
 * 否则 gentle music 会以 38 次登顶词表第一，把真正的生词挤下去。
 */
const STAGE_DIRECTION_RES = [
  /\([^()]{0,80}\)/g,
  /\[[^\[\]]{0,80}\]/g,
  /\*[^*]{1,40}\*/g,
];

/**
 * 清洗一条文本。
 * @returns {{ clean: string, dropped: boolean, reason?: string }}
 */
export function cleanFragmentText(raw) {
  let s = String(raw ?? '');
  s = decodeEntities(s);
  s = toHalfWidth(s);
  s = s.replace(HTML_TAG_RE, ' ');
  s = s.replace(URL_RE, ' ');
  s = s.replace(QQGROUP_RE, ' ');
  s = s.replace(MENTION_RE, ' ');
  s = s.replace(HASHTAG_RE, ' ');
  s = s.replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, '');
  // 字幕标记先剥（♪♪ 这种），再判断是不是纯注音节点
  s = s.replace(/[\u266a\u266b\u2669\u266c]+/g, ' ');
  // 舞台提示必须整段摘掉：字幕里的 (gentle music) 不是「说的话」，
  // 留着会让 gentle music 以 38 次登顶词汇榜（真实视频实测）
  const beforeStage = s;
  for (const re of STAGE_DIRECTION_RES) s = s.replace(re, ' ');
  const hadStage = s !== beforeStage;
  s = squashRepeats(s);
  // CJK 与拉丁之间插空格，避免「好good」粘成一个 token
  s = s.replace(/([\u4e00-\u9fa5])([A-Za-z])/g, '$1 $2').replace(/([A-Za-z])([\u4e00-\u9fa5])/g, '$1 $2');
  s = s.replace(/\s+/g, ' ').trim();
  // 只剩舞台提示（剥完没有字母）→ 整条不是台词
  if (hadStage && !/[A-Za-z]/.test(s)) return { clean: s, dropped: true, reason: 'stage-direction' };
  if (!/[A-Za-z]/.test(s)) return { clean: s, dropped: true, reason: 'no-latin' };
  return { clean: s, dropped: false };
}

/** 句子切分：用于短语抽取 */
export function splitSentences(text) {
  const parts = text
    .split(/[.!?\u2026\u3002\uff01\uff1f\uff1b;]+|\s{2,}/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  // 语音识别的英文 srt 常整段没有句末标点，一整句 40 个词会让短语统计失效。
  // 这里对超长「句子」再按逗号切一刀（只影响短语统计，正文不受影响）。
  const out = [];
  for (const s of parts) {
    if (s.split(/\s+/).length <= 25 || !s.includes(',')) {
      out.push(s);
      continue;
    }
    for (const piece of s.split(/[,，、]+/)) {
      const t = piece.trim();
      if (t) out.push(t);
    }
  }
  return out;
}
