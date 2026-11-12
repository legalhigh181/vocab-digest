/**
 * 多词表（词库）存储。
 *
 * 用户要的是「不同的视频对应不同的词表，可以新建、重命名、切换」。
 * 目录布局（全部在 data/wordlists/ 下，便于整体备份）：
 *
 *   data/wordlists/
 *     索引.json                 ← { version, activeId, lists: [{id, name, createdAt, updatedAt, count}] }
 *     day11-doctor/
 *       meta.json               ← 这张表的元信息 + 关联的视频
 *       cards.json              ← 卡片数组（一个词条一张卡，带 senses）
 *       known.txt               ← 这张表里「已掌握」的词（过滤用）
 *
 * 为什么用 JSON 而不是数据库：用户要能手改、能备份、能进 git；词表规模在几千条量级，JSON 完全够。
 */
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { normalizeLanguage } from '../languages/index.js';
import { normalizeJaEntryKey } from '../ja/entrykey.js';
import { cardsHash, cardsToText, dedupeCards, parseWordListText, primarySense } from './import.js';

/** 词表语言：非法值一律回落到 en（词表是用户资产，不能因为一个错字就打不开） */
function normalizeLanguageOr(value, fallback = 'en') {
  if (value == null || value === '') return fallback;
  try {
    return normalizeLanguage(value);
  } catch {
    return fallback;
  }
}

export const INDEX_FILE = '索引.json';
const SCHEMA_VERSION = 1;

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, obj) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}


/** 原子写：先写 .tmp 再 rename，避免写一半断电留下坏文件 */
function writeJsonAtomic(file, obj) {
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

/**
 * 原子写纯文本。
 *
 * 以前 known.txt 是用 writeJsonAtomic(file, '') 写的，落盘成了 JSON 字符串 `""`
 * （两个字面引号），下游按行读词时会把引号当成词的一部分。纯文本只能用这个。
 */
function writeTextAtomic(file, text) {
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
}

/**
 * 把 count 规整成非负整数。
 *
 * 历史 bug：有的调用点传的是对象 `{ count: n }`，直接落盘就成了 `"count":{"count":3}`，
 * 界面上显示成 [object Object]。这里统一做类型收敛，再脏的值也变成合法整数。
 */
export function normalizeCount(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.trunc(n));
}

/** 读 known.txt：一行一个词；顺手把历史遗留的 JSON 字符串 `""` 当成空表读 */
export function readKnownFile(file) {
  if (!existsSync(file)) return [];
  let raw = readFileSync(file, 'utf8');
  const trimmed = raw.trim();
  // 旧版本 create() 用 JSON 写空文本，盘上会是 `""`
  if (trimmed === '""' || trimmed === '[]' || trimmed === 'null') return [];
  if (trimmed.startsWith('["')) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) raw = arr.join('\n');
    } catch { /* 不是 JSON，按普通文本处理 */ }
  }
  return raw.split(/\r\n|\r|\n/).map((s) => s.trim()).filter(Boolean);
}

/** 把名字变成安全的目录名（保留中文，去掉路径分隔符） */
export function slugify(name) {
  const base = String(name).trim().replace(/[\\/:*?"<>|\s]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return base.slice(0, 40) || 'list';
}

export class WordlistStore {
  constructor(dataDir, opts = {}) {
    this.dataDir = dataDir;
    this.root = join(dataDir, 'wordlists');
    this.indexFile = join(this.root, INDEX_FILE);
    // 界面用：第一次打开时自动给一张空表。命令行/测试默认不自动建，避免凭空多出一张表。
    this.bootstrap = Boolean(opts.bootstrap);
  }

  /** 读索引；不存在就先初始化（不写盘，写盘放在 ensure） */
  index() {
    const idx = readJson(this.indexFile, null);
    if (!idx || !Array.isArray(idx.lists)) {
      return { version: SCHEMA_VERSION, activeId: '', lists: [] };
    }
    return idx;
  }

  saveIndex(idx) {
    writeJsonAtomic(this.indexFile, { ...idx, version: SCHEMA_VERSION });
  }

  ensure() {
    mkdirSync(this.root, { recursive: true });
    let idx = this.index();
    if (!existsSync(this.indexFile)) this.saveIndex(idx);
    // 第一次用（或者词表被清空）时给一张空表，免得界面上一张表都没有、无从下手
    if (this.bootstrap && idx.lists.length === 0 && !this._bootstrapping) {
      this._bootstrapping = true;
      try {
        this.create({ name: '我的词汇' });
      } finally {
        this._bootstrapping = false;
      }
      idx = this.index();
    }
    return idx;
  }

  list() {
    const idx = this.index();
    return idx.lists.map((l) => ({ ...l, active: l.id === idx.activeId }));
  }

  dirOf(id) {
    return join(this.root, id);
  }

  exists(id) {
    return this.index().lists.some((l) => l.id === id);
  }

  meta(id) {
    return readJson(join(this.dirOf(id), 'meta.json'), null);
  }

  /** 读卡片；文件损坏时返回空数组并带 error，不抛栈 */
  cards(id) {
    const file = join(this.dirOf(id), 'cards.json');
    const raw = readJson(file, null);
    if (!raw) return { cards: [], error: existsSync(file) ? 'cards.json 解析失败' : '', hash: '' };
    const cards = Array.isArray(raw.cards) ? raw.cards : [];
    return { cards, error: '', hash: raw.hash ?? cardsHash(cards) };
  }

  /**
   * 新建词表。
   * @param {object|string} opts 推荐传 `{ name, cards?, words?, source?, scene?, language? }`；
   *   也兼容老写法 `create('表名', { language })`
   */
  create(opts = {}, extra = {}) {
    // 兼容两种调用：create({name,...}) 与 create('名字', {...})
    const o = typeof opts === 'string' ? { ...extra, name: opts } : { ...extra, ...opts };
    const name = String(o.name ?? '').trim() || `词表 ${new Date().toISOString().slice(0, 10)}`;
    const idx = this.ensure();
    let id = slugify(name);
    let n = 2;
    while (idx.lists.some((l) => l.id === id)) { id = `${slugify(name)}-${n}`; n += 1; }
    // 语言必须**落盘**：没有它就无法拒绝跨语言使用，也无法在重渲染时选对规则
    const listLanguage = normalizeLanguageOr(o.language, 'en');

    mkdirSync(this.dirOf(id), { recursive: true });
    const now = new Date().toISOString();
    const cards = dedupeCards(o.cards ?? []);
    this.writeCards(id, cards);
    // 空 known 必须写真正空文本（以前这里用 JSON 写，落盘是 `""`）
    writeTextAtomic(join(this.dirOf(id), 'known.txt'), '');
    const meta = {
      id, name, createdAt: now, updatedAt: now,
      language: listLanguage,
      source: o.source ?? '',
      videos: o.videos ?? [],
      note: o.note ?? '',
      count: cards.length,
    };
    writeJsonAtomic(join(this.dirOf(id), 'meta.json'), meta);
    idx.lists.push({ id, name, createdAt: now, updatedAt: now, count: cards.length, language: listLanguage });
    if (!idx.activeId) idx.activeId = id;
    this.saveIndex(idx);
    return { ...meta, cards: cards.length };
  }

  writeCards(id, cards) {
    // 落盘前统一 entryKey：老 NUL 格式（`ja\0词形\0读音\0词性`）在这里就地升级成
    // `ja|词形|读音|词性`，保证「旧卡片 → 新引擎」时同形异读的键仍然对得上。
    const normalized = (cards ?? []).map((c) => (
      c && typeof c.entryKey === 'string' && c.entryKey
        ? { ...c, entryKey: normalizeJaEntryKey(c.entryKey) }
        : c
    ));
    writeJsonAtomic(join(this.dirOf(id), 'cards.json'), { hash: cardsHash(normalized), cards: normalized });
  }

  /** 重命名（id 不变，只改名 —— 用户词表里存的引用不会断） */
  rename(id, newName) {
    const name = String(newName ?? '').trim();
    if (!name) throw new Error('名字不能为空');
    const idx = this.ensure();
    const entry = idx.lists.find((l) => l.id === id);
    if (!entry) throw new Error(`词表不存在：${id}`);
    entry.name = name;
    entry.updatedAt = new Date().toISOString();
    this.saveIndex(idx);
    const meta = this.meta(id) ?? {};
    writeJsonAtomic(join(this.dirOf(id), 'meta.json'), { ...meta, name, updatedAt: entry.updatedAt });
    return entry;
  }

  setActive(id) {
    const idx = this.ensure();
    if (!idx.lists.some((l) => l.id === id)) throw new Error(`词表不存在：${id}`);
    idx.activeId = id;
    this.saveIndex(idx);
    return id;
  }

  /**
   * 删除：先挪到回收站目录，误删还能捞回来。
   *
   * 关键约束：**挪不动就报错，绝不退回永久删除**。
   * 以前是 `catch { rmSync(..., recursive) }`，一旦回收站被占用/权限不够，
   * 用户的词表会被静默删光、连索引里那条记录都保不住。
   * 现在失败时词表目录、索引和 activeId 全部原样保留，并抛出可读的错误。
   * @param {string} id
   * @param {object} opts { trashDir? 自定义回收站目录（测试与多盘场景用） }
   */
  remove(id, opts = {}) {
    const idx = this.ensure();
    const i = idx.lists.findIndex((l) => l.id === id);
    if (i < 0) throw new Error(`词表不存在：${id}`);

    const src = this.dirOf(id);
    const trashDir = opts.trashDir ? String(opts.trashDir) : join(this.root, '.trash');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = join(trashDir, `${id}@${stamp}`);

    const hasDir = existsSync(src);
    if (hasDir) {
      try {
        mkdirSync(trashDir, { recursive: true });
        renameSync(src, dest);
      } catch (e) {
        const err = new Error(
          `删除「${id}」失败：搬不进回收站（${e.message}）。${trashDir}——`
          + '词表原样保留，没有任何数据被删除。请检查该目录的磁盘空间与写权限，或先手动把它挪走再删。',
        );
        err.code = 'WORDLIST_TRASH_FAILED';
        err.listId = id;
        err.trashDir = trashDir;
        throw err;
      }
    }

    // 只有搬成功了才动索引；中途任何异常都不会让索引与磁盘对不上
    idx.lists.splice(i, 1);
    if (idx.activeId === id) idx.activeId = idx.lists[0]?.id ?? '';
    this.saveIndex(idx);
    return { removed: id, activeId: idx.activeId, trash: hasDir ? dest : '' };
  }

  /** 往给定词表里加卡片（存在则合并释义），返回新增数量 */
  addCards(id, cards) {
    const { cards: cur } = this.cards(id);
    const merged = dedupeCards([...cur, ...cards]);
    this.writeCards(id, merged);
    this.touch(id, merged.length);
    return { added: merged.length - cur.length, total: merged.length };
  }

  /**
   * 更新词条的计数与时间戳。
   *
   * 签名统一成 touch(id, count)：count 必须是数字（或能转成数字），
   * 落盘前一律过 normalizeCount，保证索引与 meta.json 里是非负整数。
   * 历史 bug：有调用点传的是 `{ count: n }`，落盘成对象，界面显示 [object Object]。
   */
  touch(id, count) {
    const n = normalizeCount(count);
    const idx = this.ensure();
    const entry = idx.lists.find((l) => l.id === id);
    const now = new Date().toISOString();
    if (entry) { entry.count = n; entry.updatedAt = now; this.saveIndex(idx); }
    const meta = this.meta(id);
    if (meta) writeJsonAtomic(join(this.dirOf(id), 'meta.json'), { ...meta, count: n, updatedAt: now });
    return n;
  }

  /**
   * 从词表文件导入并新建一张表。
   *
   * 掌握状态：**默认不标掌握**。导入 ≠ 已经认识这些词，把整张表一股脑写进
   * known.txt 会让这些词在后续分析里被全部过滤掉。只有显式 markKnown:true
   * （确认「这张表就是我会的词」）才写入。
   * @param {object} opts { file, name?, text?, markKnown? }
   */
  importFile(opts = {}) {
    const file = opts.file;
    if (file && !existsSync(file)) throw new Error(`找不到文件：${file}`);
    const text = opts.text ?? readFileSync(file, 'utf8');
    const { cards, warnings } = parseWordListText(text, { source: file ? basename(file) : 'pasted.txt' });
    if (!cards.length) throw new Error('没有解析出任何词条（检查文件是不是「英文行 → 中文行」结构）');
    const name = opts.name || (file ? basename(file).replace(/\.[^.]+$/, '') : '导入词表');
    const created = this.create({ name, cards, source: file ? basename(file) : '' });
    const markKnown = opts.markKnown === true;
    if (markKnown) {
      writeTextAtomic(this.knownFileOf(created.id), `${cards.map((c) => c.word).sort().join('\n')}\n`);
    }
    return { ...created, warnings, markKnown };
  }

  /** 把一张表导出成老格式 txt（用户想用记事本继续编辑时） */
  /**
   * 可读文本导出（`.txt`）。
   *
   * ⚠️ **有损**：为了保持人能读、能手改，只写「词条 / 词性 / 释义 + #ja 元信息」。
   * 会丢的字段：`meaningLanguage`、`meaningSource`、`scene`、`tags`、
   * `senses[].pos` 以外的多义词结构细节。
   * 要完整搬家请用 `exportJson()`（结构化无损）。
   *
   * 返回值里带 `lossy: true`，调用方不要笼统地说「导出完整」。
   */
  exportText(id, outFile) {
    const { cards } = this.cards(id);
    const text = cardsToText(cards);
    if (outFile) { mkdirSync(join(outFile, '..'), { recursive: true }); writeFileSync(outFile, text, 'utf8'); }
    return {
      text,
      count: cards.length,
      lossy: true,
      lossyFields: ['meaningLanguage', 'meaningSource', 'scene', 'tags'],
      hint: '这是有损的可读导出；要完整保留字段请用 JSON 结构化导出',
    };
  }

  /**
   * 结构化无损导出（`.json`）。
   *
   * 与 `backup()` 的区别：
   *   - `backup()` 是**整表搬迁**（带 schema、meta、known、exportedAt）
   *   - `exportJson()` 是**数据交换**（只含语言、卡片、掌握状态），适合导入到别处
   *
   * 两者都**完整保留** entryKey / 读音 / 假名 / 词性细节 / unknown / lemmaSource /
   * 释义语言 / 释义来源 / 掌握状态。
   */
  exportJson(id, outFile) {
    const meta = this.index().lists.find((l) => l.id === id);
    const { cards } = this.cards(id);
    const payload = {
      schema: SCHEMA_VERSION,
      kind: 'wordlist-export',
      language: meta?.language ?? cards[0]?.language ?? 'en',
      name: meta?.name ?? id,
      cards,
      known: this.known(id),
      exportedAt: new Date().toISOString(),
    };
    const text = `${JSON.stringify(payload, null, 2)}\n`;
    if (outFile) { mkdirSync(join(outFile, '..'), { recursive: true }); writeFileSync(outFile, text, 'utf8'); }
    return {
      text,
      count: cards.length,
      lossy: false,
      hint: '结构化无损导出：entryKey / 读音 / 释义来源 / 掌握状态全部保留',
    };
  }

  /**
   * 从一次运行（digest.json）生成词表卡片。
   * 这就是「不同的视频又对应不同的词表」的入口：跑完视频 → 一键建表。
   */
  cardsFromDigest(digest, opts = {}) {
    const cards = [];
    const language = digest.language ?? 'en';
    for (const it of digest.items ?? []) {
      if (opts.skipPhrases && it.pos === 'phr.') continue;
      const senses = [];
      if (it.meaning) {
        senses.push({
          pos: it.pos ?? '',
          meaning: it.meaning,
          meaningLanguage: it.meaningLanguage || 'zh',
          meaningSource: it.meaningSource || 'provider',
        });
      } else if (it.pos) senses.push({ pos: it.pos, meaning: '' });
      const card = {
        word: language === 'ja' ? String(it.word) : String(it.word).toLowerCase(),
        display: it.display || it.word,
        kind: it.pos === 'phr.' ? 'phrase' : 'word',
        senses,
        scene: it.scene ?? [],
        tags: it.pos === 'phr.' ? ['短语'] : [],
        source: opts.source ?? '',
        count: it.count,
        usages: (it.usages ?? []).slice(0, 3),
      };
      // ── 日文专有字段：必须随卡片一起存下来，备份/导出/重渲染都不能丢 ──
      if (language === 'ja' || it.language === 'ja') {
        card.language = 'ja';
        card.entryKey = normalizeJaEntryKey(it.entryKey ?? '');
        card.reading = it.reading ?? '';
        card.readingHiragana = it.readingHiragana ?? '';
        card.posDetail = it.posDetail ?? '';
        card.unknown = Boolean(it.unknown);
        card.lemmaSource = it.lemmaSource ?? '';
        card.pos = it.pos ?? '';
      } else {
        card.language = 'en';
      }
      cards.push(card);
    }
    return cards;
  }

  /** 引擎用：把一张表转成 {pos, meaning} 补丁 + 词典词集合 */
  lexiconPatch(id) {
    const { cards } = this.cards(id);
    const pos = {};
    const decisions = {};
    const words = new Set();
    for (const c of cards) {
      words.add(c.word);
      const { pos: p, meaning } = primarySense(c);
      if (p && POS_KEYS.has(p)) pos[c.word] = p;
      if (meaning) decisions[c.word] = { meaning };
    }
    return { pos, decisions, words };
  }

  /**
   * 日文用：按 entryKey 索引的释义表。
   *
   * 日文卡片的 key 形如 `ja|日本|ニホン|prop.`（与引擎的 jaEntryKey 一致）。
   * 老卡片可能是 NUL 格式，这里统一归一后再入表，否则新引擎查不到旧释义。
   * 同时提供退化键：
   *   - `词形` → 只在没有冲突时可用（同形异读不能串项）
   *   - `词形|读音` → 词性不一致时兜底
   *
   * @returns {Map<string, {meaning:string, meaningLanguage:string, sourceDetail:string}>}
   */
  meaningsByEntryKey(id) {
    const { cards } = this.cards(id);
    const out = new Map();
    const bareWord = new Map(); // word → 记录数组（用于检测冲突）
    for (const c of cards) {
      const meaning = c.senses.map((s) => s.meaning).filter(Boolean).join('；');
      if (!meaning) continue;
      const rec = {
        meaning,
        meaningLanguage: c.meaningLanguage || 'zh',
        sourceDetail: `词表：${this.meta(id)?.name ?? id}`,
      };
      const key = normalizeJaEntryKey(c.entryKey ?? '');
      if (key) out.set(key, rec);
      const w = String(c.word ?? '');
      if (w) {
        const arr = bareWord.get(w) ?? [];
        arr.push(rec);
        bareWord.set(w, arr);
      }
    }
    // 只有「这个词在词表里没有歧义」时才按裸词形兜底
    for (const [w, arr] of bareWord) {
      if (arr.length === 1) out.set(w, arr[0]);
    }
    return out;
  }

  /** 已掌握词（这张表过滤掉的） */
  knownFileOf(id) {
    return join(this.dirOf(id), 'known.txt');
  }

  /** 读这张表的已掌握词；历史遗留的 `""` / JSON 数组都能读成正确结果 */
  known(id) {
    return readKnownFile(this.knownFileOf(id));
  }

  /** 覆盖写已掌握词（传空数组 = 清空成真正空文本，不是 `""`） */
  writeKnown(id, words) {
    // 老 known.txt 里可能是 NUL 格式的 entryKey，写回时统一升级（裸词形原样保留）
    const list = (Array.isArray(words) ? words : Array.from(words ?? []))
      .map((w) => (typeof w === 'string' ? normalizeJaEntryKey(w) : w));
    const text = list.length ? `${list.join('\n')}\n` : '';
    writeTextAtomic(this.knownFileOf(id), text);
    return list.length;
  }

  /**
   * 备份为单个文件（用户想搬到别的电脑）。
   *
   * ⚠️ 必须**完整保留** T4 新增的字段：entryKey / 读音 / 语言 / 释义来源 / 掌握状态。
   * 以前只写 meta + cards，known 与 schemaVersion 都丢了，恢复后「已掌握」状态全部消失。
   */
  backup(id, outFile) {
    const meta = this.meta(id) ?? { id };
    const { cards } = this.cards(id);
    const known = this.known(id);
    const payload = {
      schema: SCHEMA_VERSION,
      meta,
      cards,
      /** 已掌握词（恢复时原样写回） */
      known,
      exportedAt: new Date().toISOString(),
    };
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return { outFile, count: cards.length, known: known.length };
  }

  /**
   * 从备份文件恢复成一张新表。
   *
   * 与 create() 的区别：按备份里的 cards 原样写（不过 dedupe、不改 word 大小写），
   * 并写回 known.txt，保证「备份 → 恢复 → 重渲染」字段与掌握状态一致。
   *
   * @param {string} file 备份 json 路径
   * @param {object} opts { name? 覆盖表名 }
   */
  restoreBackup(file, opts = {}) {
    if (!existsSync(file)) throw new Error(`找不到备份文件：${file}`);
    let payload;
    try {
      payload = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      const err = new Error(`备份文件不是合法 JSON：${e.message}`);
      err.code = 'BACKUP_INVALID';
      throw err;
    }
    const cards = Array.isArray(payload?.cards) ? payload.cards : [];
    if (!cards.length) {
      const err = new Error('备份里没有卡片');
      err.code = 'BACKUP_EMPTY';
      throw err;
    }
    const name = String(opts.name ?? payload?.meta?.name ?? '恢复的词表').trim() || '恢复的词表';
    const created = this.create({ name, cards: [], source: payload?.meta?.source ?? '' });
    // 原样写卡片（dedupeCards 只按 word 合并，日文同形异读会被误合，所以这里直接写）
    this.writeCards(created.id, cards);
    // 掌握状态原样写回
    const known = Array.isArray(payload?.known) ? payload.known : [];
    this.writeKnown(created.id, known);
    this.touch(created.id, cards.length);
    return { ...this.meta(created.id), cards: cards.length, known: known.length, backupSchema: payload?.schema ?? null };
  }
}

/** 词性表里认识的键（跟 data/pos.json 的四个分组合一） */
export const POS_KEYS = new Set(['n.', 'v.', 'adj.', 'adv.', 'phr.', 'prop.', 'num.', 'other']);

export { cardsHash, parseWordListText, primarySense };
