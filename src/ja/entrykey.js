/**
 * 日文条目键（entryKey）的唯一实现。
 *
 * 之所以单独成一个模块：词表 store、导入器、Web 服务端都要用它，
 * 但它们不该为此把整个日文引擎（分词器、清洗、抽词）拖进来。
 *
 * 键形：`ja|<词形>|<读音>|<词性>`
 *   - 必须含读音：同形同词性的词可能读音不同（日本 ニホン / ニッポン）
 *   - 读音未知（未知词）用 `?` 占位，与「读音已知但为空」区分
 *   - 词形/读音/词性里真出现 `|` 时转义成 `\|`
 *
 * ## 为什么用 `|` 而不是 `\u0000`
 *
 * 最初用的是 NUL 分隔（`ja\0词形\0…`），在内存里很干净，但**一旦落到文本就出问题**：
 *   - 导出词表时 NUL 是不可见字符，用户复制/编辑极易无声破坏
 *   - 再导入时 `\S*` 正则在 NUL 处截断，键直接丢掉
 *   - 有些编辑器/剪贴板会静默剥离 NUL
 *
 * 换成 `|` 后可打印、可复制、可人工核对。老数据靠 `normalizeJaEntryKey()` 兼容。
 */

/** 老的 NUL 分隔键前缀（T3 早期：`ja\0词形\0读音\0词性`） */
export const LEGACY_JA_KEY_PREFIX = 'ja\u0000';

/** 造一个 entryKey */
export function jaEntryKey(word, pos, reading, unknown = false) {
  const esc = (s) => String(s ?? '').replace(/\|/g, '\\|');
  const readPart = reading || (unknown ? '?' : '');
  return `ja|${esc(word)}|${esc(readPart)}|${esc(pos)}`;
}

/**
 * 把**老格式** entryKey 归一成现在可打印的 `ja|词形|读音|词性`。
 *
 * 为什么需要它：格式在 T3 中途从 NUL 改成了 `|`，但落盘的数据（旧 known.txt、
 * 旧 decisions.json、旧词表卡片、旧 digest.json）里仍然是 NUL。如果不归一，
 * 用户「已掌握」「人工修订」这些**已经掌握过的状态**会在升级后静默失效。
 *
 * 规则：
 *   - 非字符串 / 空 → ''
 *   - 不是 `ja\0` 开头（英文键、裸词形）→ 原样返回，绝不改写
 *   - `ja\0词形\0读音\0词性` → 用 `jaEntryKey()` 重建（顺带转义词形里的 `|`）
 *   - 段数不对（曾被 NUL 截断）→ 原样返回，宁可对不上也不要造出假键
 *
 * 幂等：新格式键过一遍不变。
 */
export function normalizeJaEntryKey(key) {
  if (typeof key !== 'string' || !key) return '';
  if (!key.startsWith(LEGACY_JA_KEY_PREFIX)) return key;
  const parts = key.split('\u0000');
  if (parts.length !== 4 || parts[0] !== 'ja') return key;
  const [, word, reading, pos] = parts;
  const unknown = reading === '?';
  return jaEntryKey(word, pos, unknown ? '' : reading, unknown);
}

/** 把 entryKey 拆回 { word, reading, pos }（导入、迁移、调试用） */
export function parseJaEntryKey(key) {
  const s = normalizeJaEntryKey(typeof key === 'string' ? key : '');
  if (!s.startsWith('ja|')) return null;
  const parts = [];
  let buf = '';
  for (let i = 3; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') { buf += '|'; i += 1; continue; }
    if (ch === '|') { parts.push(buf); buf = ''; continue; }
    buf += ch;
  }
  parts.push(buf);
  if (parts.length !== 3) return null;
  return { word: parts[0], reading: parts[1] === '?' ? '' : parts[1], pos: parts[2] };
}
