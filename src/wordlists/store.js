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
  copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { cardsHash, cardsToText, dedupeCards, parseWordListText, primarySense } from './import.js';

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
   * @param {object} opts { name, cards?, words?, source?, scene? }
   */
  create(opts = {}) {
    const name = String(opts.name ?? '').trim() || `词表 ${new Date().toISOString().slice(0, 10)}`;
    const idx = this.ensure();
    let id = slugify(name);
    let n = 2;
    while (idx.lists.some((l) => l.id === id)) { id = `${slugify(name)}-${n}`; n += 1; }

    mkdirSync(this.dirOf(id), { recursive: true });
    const now = new Date().toISOString();
    const cards = dedupeCards(opts.cards ?? []);
    this.writeCards(id, cards);
    writeJsonAtomic(join(this.dirOf(id), 'known.txt'), '');
    const meta = {
      id, name, createdAt: now, updatedAt: now,
      source: opts.source ?? '',
      videos: opts.videos ?? [],
      note: opts.note ?? '',
      count: cards.length,
    };
    writeJsonAtomic(join(this.dirOf(id), 'meta.json'), meta);
    idx.lists.push({ id, name, createdAt: now, updatedAt: now, count: cards.length });
    if (!idx.activeId) idx.activeId = id;
    this.saveIndex(idx);
    return { ...meta, cards: cards.length };
  }

  writeCards(id, cards) {
    writeJsonAtomic(join(this.dirOf(id), 'cards.json'), { hash: cardsHash(cards), cards });
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

  /** 删除：先挪到回收站目录，误删还能捞回来 */
  remove(id) {
    const idx = this.ensure();
    const i = idx.lists.findIndex((l) => l.id === id);
    if (i < 0) throw new Error(`词表不存在：${id}`);
    const trash = join(this.root, '.trash');
    mkdirSync(trash, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try { renameSync(this.dirOf(id), join(trash, `${id}@${stamp}`)); } catch { rmSync(this.dirOf(id), { recursive: true, force: true }); }
    idx.lists.splice(i, 1);
    if (idx.activeId === id) idx.activeId = idx.lists[0]?.id ?? '';
    this.saveIndex(idx);
    return { removed: id, activeId: idx.activeId };
  }

  /** 往给定词表里加卡片（存在则合并释义），返回新增数量 */
  addCards(id, cards) {
    const { cards: cur } = this.cards(id);
    const merged = dedupeCards([...cur, ...cards]);
    this.writeCards(id, merged);
    this.touch(id, merged.length);
    return { added: merged.length - cur.length, total: merged.length };
  }

  touch(id, count) {
    const idx = this.ensure();
    const entry = idx.lists.find((l) => l.id === id);
    const now = new Date().toISOString();
    if (entry) { entry.count = count; entry.updatedAt = now; this.saveIndex(idx); }
    const meta = this.meta(id);
    if (meta) writeJsonAtomic(join(this.dirOf(id), 'meta.json'), { ...meta, count, updatedAt: now });
  }

  /**
   * 从词表文件导入并新建一张表。
   * @param {object} opts { file, name?, text? }
   */
  importFile(opts = {}) {
    const file = opts.file;
    if (file && !existsSync(file)) throw new Error(`找不到文件：${file}`);
    const text = opts.text ?? readFileSync(file, 'utf8');
    const { cards, warnings } = parseWordListText(text, { source: file ? basename(file) : 'pasted.txt' });
    if (!cards.length) throw new Error('没有解析出任何词条（检查文件是不是「英文行 → 中文行」结构）');
    const name = opts.name || (file ? basename(file).replace(/\.[^.]+$/, '') : '导入词表');
    const created = this.create({ name, cards, source: file ? basename(file) : '' });
    // 导入即视为「已掌握」：这张表就是使用者认识这些词的范围
    mkdirSync(this.dirOf(created.id), { recursive: true });
    writeFileSync(this.knownFileOf(created.id), `${cards.map((c) => c.word).sort().join('\n')}\n`, 'utf8');
    return { ...created, warnings };
  }

  /** 把一张表导出成老格式 txt（用户想用记事本继续编辑时） */
  exportText(id, outFile) {
    const { cards } = this.cards(id);
    const text = cardsToText(cards);
    if (outFile) { mkdirSync(join(outFile, '..'), { recursive: true }); writeFileSync(outFile, text, 'utf8'); }
    return { text, count: cards.length };
  }

  /**
   * 从一次运行（digest.json）生成词表卡片。
   * 这就是「不同的视频又对应不同的词表」的入口：跑完视频 → 一键建表。
   */
  cardsFromDigest(digest, opts = {}) {
    const cards = [];
    for (const it of digest.items ?? []) {
      if (opts.skipPhrases && it.pos === 'phr.') continue;
      const senses = [];
      if (it.meaning) senses.push({ pos: it.pos ?? '', meaning: it.meaning });
      else if (it.pos) senses.push({ pos: it.pos, meaning: '' });
      cards.push({
        word: String(it.word).toLowerCase(),
        display: it.display || it.word,
        kind: it.pos === 'phr.' ? 'phrase' : 'word',
        senses,
        scene: it.scene ?? [],
        tags: it.pos === 'phr.' ? ['短语'] : [],
        source: opts.source ?? '',
        count: it.count,
        usages: (it.usages ?? []).slice(0, 3),
      });
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

  /** 已掌握词（这张表过滤掉的） */
  knownFileOf(id) {
    return join(this.dirOf(id), 'known.txt');
  }

  /** 备份为单个文件（用户想搬到别的电脑） */
  backup(id, outFile) {
    const meta = this.meta(id) ?? { id };
    const { cards } = this.cards(id);
    const payload = { schema: SCHEMA_VERSION, meta, cards, exportedAt: new Date().toISOString() };
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return { outFile, count: cards.length };
  }
}

/** 词性表里认识的键（跟 data/pos.json 的四个分组合一） */
export const POS_KEYS = new Set(['n.', 'v.', 'adj.', 'adv.', 'phr.', 'prop.', 'num.', 'other']);

export { cardsHash, parseWordListText, primarySense };
