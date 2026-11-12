/**
 * 本地 Web 应用：只走 node: 内置模块，零依赖，零安装。
 *
 * 设计要点：
 *   - 服务只绑 127.0.0.1（不对外网开放），随机端口由启动器决定
 *   - 前端不是独立页面，而是模板（public/app.html）里的几个 JSON 数据槽：
 *       <script id="d-state" type="application/json">...</script>  初始词表/运行列表
 *       <script id="d-view"  type="application/json">...</script>  当前视图（词条 + 用法）
 *     因此服务端只拼 JSON、不拼 HTML，彻底绕开「JS 模板字符串里塞 HTML」的转义坑
 *   - 所有写操作都走 POST /api/<动作>，返回统一的 { ok, message, ... } 结构
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TAG_DIMENSIONS, TAG_DIM_LABELS, tagsOf } from '../classify.js';
import { resolveConfig } from '../config.js';
import { ensureData } from '../data/seed.js';
import { filterItems } from '../export.js';
import { cambridgeUrl, ecdictPath, openEcdict } from '../lexicon/ecdict.js';
import { applyDecisions, listRuns, readDecisions, renderRun, runDigest, runDigestAsync, wordlistFromRun } from '../run.js';
import { sortItems } from '../classify.js';
import { stablePretty } from '../util.js';
import { WordlistStore } from '../wordlists/store.js';
import { normalizeJaEntryKey } from '../ja/entrykey.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(here, '..', '..', 'app', 'public');

const DIM_LABELS = { ...TAG_DIM_LABELS, all: '全部' };

function json(res, status, body) {
  const text = JSON.stringify(body);
  // 关键：content-length 必须按 UTF-8 字节数算（中文一个字 3 字节），否则浏览器
  // 会按字节截断，中文提示变成乱码「宸叉柊寤鸿瘝琛?」
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text, 'utf8'),
  });
  res.end(Buffer.from(text, 'utf8'));
}

/** 从 content-type 里取 boundary */
function multipartBoundary(contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType ?? ''));
  return m ? (m[1] ?? m[2]).trim() : '';
}

/** 极简 multipart/form-data 解析：返回第一个文本字段与第一个文件字段 */
function parseMultipart(buf, boundary) {
  const out = { fields: {}, files: [] };
  if (!boundary || !buf?.length) return out;
  const sep = `--${boundary}`;
  const parts = buf.toString('latin1').split(sep);
  for (const raw of parts) {
    const part = raw.replace(/^\r\n/, '').replace(/\r\n$/, '');
    if (!part || part === '--') continue;
    const idx = part.indexOf('\r\n\r\n');
    if (idx < 0) continue;
    const head = part.slice(0, idx);
    const body = part.slice(idx + 4);
    const nameM = /name="([^"]*)"/i.exec(head);
    const fileM = /filename="([^"]*)"/i.exec(head);
    const rawFilename = fileM ? Buffer.from(fileM[1], 'latin1').toString('utf8') : '';
    const name = nameM ? nameM[1] : '';
    if (!name) continue;
    // 文件内容按 latin1 取过字符串，要转回原始字节再按 UTF-8 解码中文
    const bytes = Buffer.from(body, 'latin1');
    if (fileM) out.files.push({ field: name, filename: rawFilename, bytes });
    else out.fields[name] = bytes.toString('utf8');
  }
  return out;
}

function bodyOf(req, limit = 8 * 1024 * 1024) {
  return new Promise((ok, fail) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        fail(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      // 文件上传走 multipart：浏览器拿不到本地路径，只能把内容传上来
      const ctype = String(req.headers['content-type'] ?? '');
      if (ctype.includes('multipart/form-data')) {
        ok(parseMultipart(Buffer.concat(chunks), multipartBoundary(ctype)));
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return ok({});
      try {
        ok(JSON.parse(raw));
      } catch (e) {
        fail(new Error(`请求体不是合法 JSON：${e.message}`));
      }
    });
    req.on('error', fail);
  });
}

/** 词条的标签摘要（前端按维度切面用） */
function tagIndex(items) {
  const out = {};
  for (const dim of TAG_DIMENSIONS) out[dim] = [];
  const count = (dim, key, label) => {
    const arr = out[dim];
    const hit = arr.find((x) => x.key === key);
    if (hit) hit.count += 1;
    else arr.push({ key, label, count: 1 });
  };
  for (const it of items) {
    const t = tagsOf(it);
    count('pos', String(it.pos ?? 'other'), it.posLabel || String(it.pos ?? 'other'));
    const d = String(t.difficulty ?? 'unknown');
    count('difficulty', d, d === 'basic' ? '基础' : d === 'advanced' ? '进阶' : '未标注');
    const f = String(t.freq ?? 'once');
    count('freq', f, f === 'often' ? '高频' : f === 'several' ? '多次' : '一次');
    for (const s of t.source ?? []) count('source', String(s), String(s));
  }
  for (const dim of Object.keys(out)) out[dim].sort((a, b) => b.count - a.count);
  return out;
}

export function startApp(opts = {}) {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const host = opts.host ?? '127.0.0.1';
  const port = Number(opts.port ?? 0);
  // 取数实现：默认真去 B 站抓。测试可注入一个慢的假实现，
  // 用来验证「长时间 ASR 期间服务还能探活 / 任务可取消」而不用真的联网转写。
  let fetchVideoImpl = opts.fetchVideo ?? null;

  ensureData(join(cwd, 'data'));

  const cfgOf = (overrides = {}) =>
    resolveConfig({ cwd, localConfigPath: opts.localConfigPath, overrides });

  // 本地英汉词典（可选）：data/ecdict.csv 存在就用，缺失返回 null 不报错
  const dictOf = () => {
    const config = cfgOf();
    return openEcdict(ecdictPath(config.dataDir));
  };
  const lookupDict = (word) => {
    try {
      const d = dictOf();
      return d?.ready ? d.lookup(word) : null;
    } catch {
      return null;
    }
  };

  const stateOf = () => {
    const config = cfgOf();
    const store = new WordlistStore(config.dataDir, { bootstrap: true });
    store.ensure();
    const lists = store.list().map((m) => ({
      id: m.id,
      name: m.name,
      count: Number(m.count ?? 0),
      updatedAt: String(m.updatedAt ?? ''),
      // 一张表一种语言：界面按它决定显不显示假名、要不要做大小写折叠
      language: m.language === 'ja' ? 'ja' : 'en',
    }));
    const idx = store.index();
    const runs = listRuns({ cwd, dataDirOverride: config.dataDir }).map((r) => {
      let videoUrl = '';
      let page = 0;
      let language = 'en';
      try {
        const dj = JSON.parse(readFileSync(join(config.runRoot, r.runId, 'digest.json'), 'utf8'));
        videoUrl = String(dj.videoUrl ?? '');
        page = Number(dj.videoPage ?? 0) || 0;
        language = dj.language === 'ja' ? 'ja' : 'en';
      } catch {
        videoUrl = '';
      }
      return {
        runId: r.runId,
        generatedAt: String(r.generatedAt ?? ''),
        keptCount: Number(r.keptCount ?? 0),
        ok: Boolean(r.ok),
        title: String(r.title ?? ''),
        wordlist: r.wordlist ? String(r.wordlist) : '',
        language,
        videoUrl,
        page,
      };
    });
    return {
      ok: true,
      cwd,
      dataDir: config.dataDir,
      dataOk: config.dataOk,
      missingFiles: config.missingFiles.map((m) => `${m.key} → ${m.path}`),
      lists,
      activeId: String(idx.activeId ?? ''),
      runs,
      dims: TAG_DIMENSIONS.map((d) => ({ key: d, label: DIM_LABELS[d] ?? d })),
    };
  };

  /** 视图：运行 + 筛选 + 维度 */
  const viewOf = (q = {}) => {
    const config = cfgOf();
    const runId = String(q.runId ?? '');
    if (!runId) return { ok: false, message: '还没有选运行', items: [], tags: tagIndex([]), meta: {} };
    const runDir = join(config.runRoot, runId);
    if (!existsSync(join(runDir, 'digest.json'))) {
      return { ok: false, message: `运行 ${runId} 不存在`, items: [], tags: tagIndex([]), meta: {} };
    }
    const raw = JSON.parse(readFileSync(join(runDir, 'digest.json'), 'utf8'));
    const decisions = readDecisions(join(runDir, 'decisions.json'));
    const dig = applyDecisions(raw, decisions);
    // 运行标题优先用 run.json 里记下的「原视频标题」，没有再退回文件名
    let runTitle = '';
    try {
      const meta = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
      runTitle = String(meta?.title ?? '');
    } catch {
      runTitle = '';
    }
    const filter = {};
    for (const k of ['tag', 'pos', 'difficulty', 'source', 'freq']) {
      if (q[k]) filter[k] = String(q[k]);
    }
    // 搜索：按词/展示形/释义模糊匹配（前端传 q）；日文还要能按读音、假名搜
    const needle = String(q.q ?? '').trim().toLowerCase();
    const hayOf = (it) => [it.word, it.display, it.meaning, it.reading, it.readingHiragana,
      ...(Array.isArray(it.sources) ? it.sources : [])]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    let picked = filterItems(dig.items ?? [], filter);
    // 标签计数基于「只做了搜索过滤」的集合，与当前选中的标签无关
    const sortedBeforeTag = needle
      ? (dig.items ?? []).filter((it) => hayOf(it).includes(needle))
      : (dig.items ?? []);
    if (needle) {
      picked = picked.filter((it) => hayOf(it).includes(needle));
    }
    // 排序：默认按频次；time = 按最早出现时间（同视频里就是台词先后）
    const order = String(q.sort ?? 'freq');
    const sorted = [...picked];
    if (order === 'time') {
      const firstT = (it) => {
        const ts = (it.usages ?? []).map((u) => Number(u.t)).filter(Number.isFinite);
        return ts.length ? Math.min(...ts) : Number.POSITIVE_INFINITY;
      };
      sorted.sort((a, b) => {
        const ta = firstT(a);
        const tb = firstT(b);
        if (ta !== tb) return ta - tb;
        return sortItems(a, b);
      });
    } else {
      sorted.sort(sortItems);
    }
    const runLanguage = dig.language === 'ja' ? 'ja' : 'en';
    const isJa = runLanguage === 'ja';
    const items = sorted.map((it) => ({
      word: it.word,
      display: it.display,
      count: it.count,
      pos: it.pos,
      posLabel: it.posLabel,
      meaning: it.meaning,
      language: runLanguage,
      // 日文三项：读音（片假名/原样）、平假名、词性细分。
      // 英文运行时这些字段一律留空，前端只看有没有值，不靠语言分支。
      reading: isJa ? String(it.reading ?? '') : '',
      readingHiragana: isJa ? String(it.readingHiragana ?? '') : '',
      posDetail: isJa ? String(it.posDetail ?? '') : '',
      entryKey: normalizeJaEntryKey(String(it.entryKey ?? '')),
      // unknown = kuromoji 没见过这个词：不编读音、不编假名，界面标「未收录」
      unknown: isJa ? Boolean(it.unknown) : false,
      lemmaSource: isJa ? String(it.lemmaSource ?? '') : '',
      offsetExact: it.offsetExact !== false,
      phonetic: isJa ? '' : (it.phonetic ?? lookupDict(it.word)?.phonetic ?? ''),
      dictMeaning: isJa ? '' : (lookupDict(it.word)?.translation ?? ''),
      cambridge: isJa ? '' : cambridgeUrl(it.word),
      colloquial: Boolean(it.colloquial),
      scene: Array.isArray(it.scene) ? it.scene : [],
      tags: tagsOf(it),
      usages: (it.usages ?? []).map((u) => ({
        text: u.text,
        skeleton: u.skeleton ?? '',
        t: Number(u.t ?? 0),
        src: u.src ?? '',
        meaning: decisions[it.word]?.meaning ?? '',
      })),
      sources: Array.isArray(it.sources) ? it.sources : [],
    }));
    return {
      ok: true,
      runId,
      runDir,
      title: String(runTitle || dig.sources?.[0]?.name || runId),
      fileTitle: String(dig.sources?.[0]?.name ?? ''),
      videoUrl: String(dig.videoUrl ?? ''),
      videoPage: Number(dig.videoPage ?? 0) || 0,
      videoPages: Number(dig.videoPages ?? 0) || 0,
      meta: {
        stats: dig.stats ?? {},
        lexicon: dig.lexicon ?? {},
        wordlist: dig.wordlist ?? null,
        tags: dig.tags ?? {},
      },
      dim: String(q.dim ?? 'pos'),
      language: runLanguage,
      filter,
      q: needle,
      sort: order,
      itemCount: items.length,
      items,
      // 标签计数用「搜索后、但未按标签过滤」的集合，否则点了一个标签，其他标签的计数会一起缩水
      tags: tagIndex(sortedBeforeTag ?? dig.items ?? []),
    };
  };

  /** 读一份运行的 digest.json（只为了拿 language，读不出来就当 en） */
  const digOf = (runDir) => {
    try {
      return JSON.parse(readFileSync(join(runDir, 'digest.json'), 'utf8')) ?? {};
    } catch {
      return {};
    }
  };

  // ── 长任务登记表（T6：并发隔离 + 可取消）────────────────────────────
  // 转写/下载动辄几分钟。每个任务有自己的 AbortController 和独立临时目录，
  // 取消只影响自己那一条，失败也不会去动别人的产物。
  const tasks = new Map();
  // 结束的任务挪到这里再留一会儿：前端轮询到一半任务刚好结束时，?id= 还查得到最终状态，
  // 不会变成「查无此任务」让人误以为是失败了。
  const finished = new Map();
  const TASK_TTL_MS = 10 * 60_000;
  const retireTask = (id) => {
    const t = tasks.get(id);
    if (!t) return;
    tasks.delete(id);
    finished.set(id, t);
    setTimeout(() => finished.delete(id), TASK_TTL_MS).unref?.();
  };
  let taskSeq = 0;
  const newTaskId = () => {
    taskSeq += 1;
    const stamp = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return `${stamp}-${rand}-${taskSeq}`;
  };
  /** 启动一个可取消任务；同一时刻允许并存多个，但同名任务（kind）不互斥，靠 id 区分 */
  const startTask = (kind, label) => {
    const id = newTaskId();
    const ctl = new AbortController();
    const task = {
      id,
      kind,
      label: String(label ?? ''),
      startedAt: new Date().toISOString(),
      signal: ctl.signal,
      cancel: () => ctl.abort(),
      done: false,
      error: '',
    };
    tasks.set(id, task);
    // 防泄漏：不管成没成功，一段时间后从表里摘掉
    setTimeout(() => retireTask(id), TASK_TTL_MS).unref?.();
    return task;
  };
  const publicTask = (t) => ({
    id: t.id,
    kind: t.kind,
    label: t.label,
    startedAt: t.startedAt,
    done: t.done,
    error: t.error,
    // 任务结束后的最终结果（成功/失败都一样带回来），供前端轮询收尾
    result: t.result ?? null,
  });

  /**
   * 取数的真正执行体。老接口（等结果再返回）和新接口（立刻返回 taskId、后台跑）
   * 共用这一份，保证两条路径的产物、日志、错误码完全一致。
   */
  const runFetchJob = async (task, body, logs) => {
    const fetchVideo = fetchVideoImpl ?? (await import('../fetch.js')).fetchVideo;
    /** 任务结束后的最终结果；轮询 /api/tasks?id= 靠它收尾 */
    let result = null;
    try {
      const t0 = task.label.match(/BV[0-9A-Za-z]{10}/);
      const pno = body.page ? Number(body.page) : 1;
      // 任务目录按「bvid.pN」区分：并发抓同一视频不同 P 不会互相覆盖；
      // 同一 P 重复抓时复用目录，但字幕/音频文件名都带 P，旧文件也不会被误认成新结果
      const taskDir = join(cwd, 'samples', `${t0 ? t0[0] : 'fetch'}.p${pno}`);
      const r = await fetchVideo({
        link: String(body.link ?? ''),
        cwd,
        outDir: taskDir,
        page: body.page ? Number(body.page) : undefined,
        asr: body.asr !== false,
        // 抓弹幕（默认抓）与把弹幕交给分析（默认不）是两个开关
        fetchDanmaku: body.fetchDanmaku !== false,
        withDanmaku: body.withDanmaku === true,
        model: body.model ? String(body.model) : undefined,
        language: body.language ? String(body.language) : undefined,
        signal: task.signal,
        log: (m) => logs.push(String(m)),
      });
      if (!r.ok) {
        result = {
          ok: false,
          message: String(r.error ?? '取数失败'),
          code: r.code ?? '',
          taskId: task.id,
          logs,
          inputs: [],
          danmaku: r.danmaku ?? null,
        };
        return result;
      }
      const dmText = r.danmakuInfo?.ok
        ? `${r.danmaku} 条${r.withDanmaku ? '（已参与分析）' : '（只保存）'}${r.danmakuInfo.warning ? `，⚠ ${r.danmakuInfo.warning}` : ''}`
        : `未取到（${r.danmakuInfo?.error ?? '已跳过'}）`;
      result = {
        ok: true,
        message: `取数完成：字幕 ${r.subtitle} 条，弹幕 ${dmText}${r.asr ? `，语音识别 ${r.asr.seconds}s` : ''}${
          r.totalPages > 1 ? `（第 ${r.page}/${r.totalPages} P）` : ''
        }`,
        taskId: task.id,
        title: String(r.info?.title ?? ''),
        outDir: r.dir,
        // 真实路径：这些文件确实存在，可以直接交给 /api/run/digest
        inputs: r.inputs,
        labels: r.labels ?? [],
        page: r.page,
        pageTitle: r.pageTitle ?? '',
        totalPages: r.totalPages,
        cid: r.cid,
        playUrl: r.playUrl,
        danmaku: r.danmakuInfo ?? null,
        danmakuFile: r.danmakuFile ?? '',
        logs,
      };
      return result;
    } catch (e) {
      result = {
        ok: false,
        message: String(e?.message ?? e),
        code: String(e?.code ?? 'FETCH_ERROR'),
        taskId: task.id,
        inputs: [],
        logs,
      };
      return result;
    } finally {
      // 收尾：结果随任务一起带走，之后 ?id= 查得到
      task.done = true;
      task.error = result?.ok ? '' : String(result?.message ?? '');
      task.result = result;
      retireTask(task.id);
    }
  };

  const routes = {
    'GET /api/state': async () => stateOf(),
    'GET /api/view': async (_req, url) => viewOf(Object.fromEntries(url.searchParams)),
    'POST /api/wordlist/create': async (_req, _url, body) => {
      const store = new WordlistStore(cfgOf().dataDir, { bootstrap: true });
      // 语言要落到索引里：界面靠它决定显示假名还是音标；非法值按默认 en 处理，不抛
      const language = String(body.language ?? '').toLowerCase() === 'ja' ? 'ja' : 'en';
      const m = store.create({ name: String(body.name ?? '新词表'), listId: body.id, language });
      return { ok: true, message: `已新建词表「${m.name}」`, listId: m.id, language };
    },
    'POST /api/wordlist/rename': async (_req, _url, body) => {
      const store = new WordlistStore(cfgOf().dataDir, { bootstrap: true });
      const m = store.rename(String(body.id), String(body.name));
      return { ok: true, message: `已重命名为「${m.name}」`, listId: m.id };
    },
    'POST /api/wordlist/activate': async (_req, _url, body) => {
      const store = new WordlistStore(cfgOf().dataDir, { bootstrap: true });
      store.setActive(String(body.id));
      return { ok: true, message: '已切换当前词表' };
    },
    'POST /api/wordlist/add': async (_req, _url, body) => {
      const store = new WordlistStore(cfgOf().dataDir, { bootstrap: true });
      const id = String(body.id);
      const cards = (body.cards ?? []).map((c) => ({ ...c, addedAt: new Date().toISOString() }));
      store.addCards(id, cards);
      return { ok: true, message: `已加入 ${cards.length} 条到词表` };
    },
    'POST /api/wordlist/import': async (_req, _url, body) => {
      const store = new WordlistStore(cfgOf().dataDir, { bootstrap: true });
      // 从文件选择框上传的：内容在 body.files 里，没有本地路径
      if (Array.isArray(body.files) && body.files.length) {
        const f = body.files[0];
        const text = f.bytes.toString('utf8');
        if (!text.trim()) return { ok: false, message: '上传的文件是空的' };
        const r = store.importFile({
          text,
          name: body.fields?.name ? String(body.fields.name) : f.filename.replace(/\.[^.]+$/, ''),
        });
        return { ok: true, message: `已导入「${r.name}」${r.cards ?? 0} 条词条`, listId: r.id };
      }
      const r = store.importFile({
        file: resolve(cwd, String(body.file ?? '')),
        name: body.name ? String(body.name) : undefined,
      });
      return { ok: true, message: `已导入「${r.name}」${r.cards ?? 0} 条词条`, listId: r.id };
    },
    'POST /api/wordlist/export': async (_req, _url, body) => {
      const store = new WordlistStore(cfgOf().dataDir, { bootstrap: true });
      const out = resolve(cwd, String(body.out ?? ''));
      const r = store.exportText(String(body.id), out);
      return { ok: true, message: `已导出 ${r.count} 条到 ${out}` };
    },
    'POST /api/wordlist/cards': async (_req, _url, body) => {
      const store = new WordlistStore(cfgOf().dataDir, { bootstrap: true });
      const { cards } = store.cards(String(body.id));
      return {
        ok: true,
        message: '',
        cards: cards.map((c) => ({
          word: c.word, display: c.display || c.word, kind: c.kind ?? 'word',
          reading: c.reading ?? '',
          readingHiragana: c.readingHiragana ?? '',
          unknown: Boolean(c.unknown),
          language: c.language === 'ja' ? 'ja' : 'en',
          meaning: (c.senses ?? []).map((s) => `${s.pos ?? ''}${s.meaning ?? ''}`).join('；'),
        })),
      };
    },
    'POST /api/open': async (_req, _url, body) => {
      const config = cfgOf();
      const target = body.what === 'run' && body.runId
        ? join(config.runRoot, String(body.runId))
        : config.runRoot;
      if (!existsSync(target)) return { ok: false, message: `目录不存在：${target}` };
      if (process.platform === 'win32') {
        const { spawn } = await import('node:child_process');
        spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' }).unref();
      }
      return { ok: true, message: `已在资源管理器打开：${target}` };
    },
    'POST /api/run/fetch': async (_req, _url, body) => {
      // 老契约：等取数整个做完再返回结果。为了不破坏既有调用方，保持不动。
      const task = startTask('fetch', String(body.link ?? ''));
      const logs = [];
      return runFetchJob(task, body, logs);
    },
    'POST /api/run/fetch/start': async (_req, _url, body) => {
      // 新契约：立刻返回 taskId，取数在后台跑。
      // 为什么需要它：取消按钮必须在任务「还在跑」的时候拿到 id，
      // 而老接口做完才返回，等拿到 id 时已经没什么可取消的了。
      // 也不靠「任务列表里最新那条」猜归属——两个窗口同时抓不同视频就猜错。
      const task = startTask('fetch', String(body.link ?? ''));
      const logs = [];
      // 故意不 await：先把 id 交出去。异常由 runFetchJob 内部收敛成 result，
      // 这里再兜一层 catch，防止未处理的 rejection 把进程搞崩。
      runFetchJob(task, body, logs).catch(() => {});
      return {
        ok: true,
        message: '已开始取数',
        taskId: task.id,
        task: publicTask(task),
      };
    },
    /** 列出还在跑的长任务（界面用来显示「正在转写…」和提供取消按钮） */
    'GET /api/tasks': async (_req, url) => {
      // ?id=xxx：查单个任务的状态（前端轮询用）。
      // 任务结束后结果会留在 finished 表里一小段时间，前端才不会「轮询时任务刚好结束 → 查不到」。
      const id = url.searchParams.get('id');
      if (id) {
        const t = tasks.get(id) ?? finished.get(id);
        if (!t) return { ok: false, message: '没有这个任务（可能已经结束并被清理）', task: null };
        return { ok: true, task: publicTask(t) };
      }
      return {
        ok: true,
        tasks: [...tasks.values()].filter((t) => !t.done).map(publicTask),
      };
    },
    /** 取消一个长任务：只 abort 它自己，其他任务不受影响 */
    'POST /api/tasks/cancel': async (_req, _url, body) => {
      // 只取消还在跑的；已经结束的任务取消是空操作（但要说清楚，别让人以为没生效）
      const id = String(body.id ?? '');
      const t = tasks.get(id);
      if (!t) {
        const f = finished.get(id);
        return f
          ? { ok: false, message: `任务已经结束了（${f.error || '正常完成'}），不用再取消` }
          : { ok: false, message: '没有这个任务（可能已经结束）' };
      }
      t.cancel();
      return { ok: true, message: `已请求取消：${t.label || t.id}` };
    },
    'POST /api/run/digest': async (_req, _url, body) => {
      const inputs = Array.isArray(body.inputs) ? body.inputs.map(String) : [];
      if (!inputs.length) return { ok: false, message: '请提供输入文件（字幕 srt/json 或字幕 XML 等）' };
      // 语言：显式传入的优先；没传就交给配置（默认 en）。
      // 非法值由 normalizeLanguage 抛 INVALID_LANGUAGE，这里转成可读错误。
      const language = body.language ? String(body.language) : undefined;
      const ov = {};
      if (body.minLen != null) ov.lexicon = { ...(ov.lexicon ?? {}), minLen: Number(body.minLen) };
      if (body.minFreq != null) ov.lexicon = { ...(ov.lexicon ?? {}), minFreq: Number(body.minFreq) };
      const common = {
        cwd,
        inputs: inputs.map((p) => resolve(cwd, p)),
        wordlist: body.wordlist ? String(body.wordlist) : undefined,
        configOverrides: ov,
        localConfigPath: opts.localConfigPath,
        title: body.title ? String(body.title) : undefined,
        videoUrl: body.link ? String(body.link) : undefined,
        videoTitle: body.title ? String(body.title) : undefined,
        // 多 P 视频：记下是第几 P、共几 P，点时间戳才能跳到正确的分 P
        videoPage: body.page ? Number(body.page) : undefined,
        videoPages: body.totalPages ? Number(body.totalPages) : undefined,
      };
      let res;
      try {
        res = language === 'ja' || language === 'jp'
          ? await runDigestAsync({ ...common, language })
          : runDigest({ ...common, language });
      } catch (e) {
        if (e.code === 'INVALID_LANGUAGE') {
          return { ok: false, message: `不支持的语言：${language}（只接受 en / ja）` };
        }
        throw e;
      }
      return {
        ok: Boolean(res.verify?.ok),
        message: `运行 ${res.runId} 完成：${res.stats?.keptCount ?? 0} 个词条，自检${res.verify?.ok ? '通过' : '未通过'}`,
        runId: res.runId,
        docx: res.outputs?.docx ?? '',
        stats: res.stats ?? {},
        tags: res.tags ?? {},
        language: res.language,
      };
    },
    'POST /api/run/build': async (_req, _url, body) => {
      const runDir = join(cfgOf().runRoot, String(body.runId ?? ''));
      if (!existsSync(join(runDir, 'digest.json'))) return { ok: false, message: '运行不存在' };
      const ov = {};
      if (body.by) ov.classify = { by: String(body.by).split(',').map((s) => s.trim()).filter(Boolean) };
      // 重出 Word 时语言默认沿用这次运行自己的；只有显式传了才覆盖（用来纠正录错语言的旧运行）
      if (body.language) ov.language = String(body.language) === 'ja' ? 'ja' : 'en';
      const r = renderRun({ cwd, runDir, configOverrides: ov, localConfigPath: opts.localConfigPath });
      return { ok: Boolean(r.verify?.ok), message: `已重新生成 ${r.docxPath}`, docx: r.docxPath };
    },
    'POST /api/wordlist/fromRun': async (_req, _url, body) => {
      const config = cfgOf();
      const store = new WordlistStore(config.dataDir, { bootstrap: true });
      const r = wordlistFromRun(store, String(body.runId ?? ''), {
        name: body.name ? String(body.name) : undefined,
        listId: body.listId ? String(body.listId) : undefined,
        replace: body.replace === true,
      });
      return { ok: true, message: `已从运行生成词表「${r.name}」`, listId: r.id ?? r.listId ?? '' };
    },
    'POST /api/decisions': async (_req, _url, body) => {
      const runDir = join(cfgOf().runRoot, String(body.runId ?? ''));
      if (!existsSync(join(runDir, 'digest.json'))) return { ok: false, message: '运行不存在' };
      const file = join(runDir, 'decisions.json');
      const cur = existsSync(file) ? readDecisions(file) : {};
      // 这份运行的词条是「词」索引还是 entryKey 索引，取决于它的语言：
      // 英文小写折叠（Apple/apple 算一个词），日文不能折叠也不能只用词形（同形异读会被并掉）。
      const runLanguage = digOf(runDir).language === 'ja' ? 'ja' : 'en';
      const rawWord = String(body.word ?? '').trim();
      const word = runLanguage === 'ja' ? rawWord : rawWord.toLowerCase();
      if (!word) return { ok: false, message: '缺少单词' };
      // 日文优先落到 entryKey 上，这样「日本 ニホン」和「日本 ニッポン」能各自记各自的释义。
      // 老运行 / 老卡片传来的键可能是 NUL 格式，统一归一后再写，避免同一词出现两个键。
      const key = runLanguage === 'ja' && body.entryKey
        ? normalizeJaEntryKey(String(body.entryKey))
        : word;
      const patch = {};
      if (body.pos) patch.pos = String(body.pos);
      if (body.meaning != null) patch.meaning = String(body.meaning);
      cur[key] = { ...(cur[key] ?? {}), ...patch };
      writeFileSync(file, stablePretty(cur), 'utf8');
      return { ok: true, message: `已记录 ${word} 的词性/释义` };
    },
  };

  const statics = {
    '/': 'app.html',
    '/app.js': 'app.js',
    '/app.css': 'app.css',
    '/whale.svg': 'whale.svg',
    '/whale-small.svg': 'whale-small.svg',
    '/bow.svg': 'bow.svg',
  };

  const server = createServer(async (req, res) => {
    // port 传 0 时由系统分配，真正的端口要到 listen 之后才知道 —— 用 req.headers.host 兜底
    const base = `http://${req.headers.host || `${host}:${port || server.address()?.port || 0}`}`;
    const rawUrl = req.url && req.url.startsWith('/') ? req.url : '/';
    const url = new URL(rawUrl, base);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      // 模板块：把初始状态塞进 app.html 的数据槽
      if (path === '/' || statics[path] === 'app.html') {
        // 带 ?runId= 打开时直接把那次运行渲染进数据槽，刷新也不会丢选中状态
        const wantRun = url.searchParams.get('runId');
        const initialView = wantRun
          ? viewOf(Object.fromEntries(url.searchParams))
          : { ok: false, items: [], message: '选择一个运行' };
        const html = readFileSync(join(PUBLIC_DIR, 'app.html'), 'utf8')
          .replace('<script id="d-state" type="application/json">{}</script>', `<script id="d-state" type="application/json">${JSON.stringify(stateOf())}</script>`)
          .replace('<script id="d-view" type="application/json">{}</script>', `<script id="d-view" type="application/json">${JSON.stringify(initialView)}</script>`);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(html);
        return;
      }
      if (statics[path]) {
        const file = join(PUBLIC_DIR, statics[path]);
        const type = path.endsWith('.js') ? 'text/javascript; charset=utf-8'
          : path.endsWith('.svg') ? 'image/svg+xml; charset=utf-8'
            : path.endsWith('.png') ? 'image/png'
              : 'text/css; charset=utf-8';
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
        res.end(readFileSync(file));
        return;
      }
      // 素材图（app/public/img/*.png）—— 白名单目录，只允许 png，防目录穿越
      if (path.startsWith('/img/')) {
        const name = path.slice(5);
        if (/^[a-z0-9_-]+\.png$/i.test(name)) {
          const file = join(PUBLIC_DIR, 'img', name);
          if (existsSync(file)) {
            res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=86400' });
            res.end(readFileSync(file));
            return;
          }
        }
      }
      const key = `${req.method} ${path}`;
      const handler = routes[key];
      if (!handler) {
        json(res, 404, { ok: false, message: `没有这个接口：${key}` });
        return;
      }
      const body = req.method === 'POST' ? await bodyOf(req) : {};
      const out = await handler(req, url, body);
      json(res, 200, out);
    } catch (err) {
      json(res, 200, { ok: false, message: String(err?.message ?? err), code: String(err?.code ?? '') });
    }
  });

  return new Promise((ok) => {
    server.listen(port, host, () => {
      const p = server.address().port;
      ok({
        server,
        port: p,
        url: `http://${host}:${p}/`,
        /** 测试用：换掉取数实现（默认是真抓 B 站） */
        setFetchVideo: (fn) => { fetchVideoImpl = fn; },
      });
    });
  });
}
