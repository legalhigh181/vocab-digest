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
import { applyDecisions, listRuns, readDecisions, renderRun, runDigest, wordlistFromRun } from '../run.js';
import { stablePretty } from '../util.js';
import { WordlistStore } from '../wordlists/store.js';

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
    }));
    const idx = store.index();
    const runs = listRuns({ cwd, dataDirOverride: config.dataDir }).map((r) => ({
      runId: r.runId,
      generatedAt: String(r.generatedAt ?? ''),
      keptCount: Number(r.keptCount ?? 0),
      ok: Boolean(r.ok),
      title: String(r.title ?? ''),
      wordlist: r.wordlist ? String(r.wordlist) : '',
    }));
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
    const items = filterItems(dig.items ?? [], filter).map((it) => ({
      word: it.word,
      display: it.display,
      count: it.count,
      pos: it.pos,
      posLabel: it.posLabel,
      meaning: it.meaning,
      phonetic: it.phonetic ?? lookupDict(it.word)?.phonetic ?? '',
      dictMeaning: lookupDict(it.word)?.translation ?? '',
      cambridge: cambridgeUrl(it.word),
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
      meta: {
        stats: dig.stats ?? {},
        lexicon: dig.lexicon ?? {},
        wordlist: dig.wordlist ?? null,
        tags: dig.tags ?? {},
      },
      dim: String(q.dim ?? 'pos'),
      filter,
      itemCount: items.length,
      items,
      tags: tagIndex(dig.items ?? []),
    };
  };

  const routes = {
    'GET /api/state': async () => stateOf(),
    'GET /api/view': async (_req, url) => viewOf(Object.fromEntries(url.searchParams)),
    'POST /api/wordlist/create': async (_req, _url, body) => {
      const store = new WordlistStore(cfgOf().dataDir, { bootstrap: true });
      const m = store.create({ name: String(body.name ?? '新词表'), listId: body.id });
      return { ok: true, message: `已新建词表「${m.name}」`, listId: m.id };
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
      const { fetchVideo } = await import('../fetch.js');
      const logs = [];
      const r = await fetchVideo({
        link: String(body.link ?? ''),
        cwd,
        page: body.page ? Number(body.page) : undefined,
        asr: body.asr !== false,
        withDanmaku: body.withDanmaku === true,
        model: body.model ? String(body.model) : undefined,
        log: (m) => logs.push(String(m)),
      });
      if (!r.ok) {
        return { ok: false, message: String(r.error ?? '取数失败'), logs, inputs: [] };
      }
      return {
        ok: true,
        message: `取数完成：字幕 ${r.subtitle} 条，弹幕 ${r.danmaku} 条${r.asr ? `，语音识别 ${r.asr.seconds}s` : ''}`,
        title: String(r.info?.title ?? ''),
        outDir: r.dir,
        inputs: r.inputs,
        logs,
      };
    },
    'POST /api/run/digest': async (_req, _url, body) => {
      const inputs = Array.isArray(body.inputs) ? body.inputs.map(String) : [];
      if (!inputs.length) return { ok: false, message: '请提供输入文件（字幕 srt/json 或字幕 XML 等）' };
      const ov = {};
      if (body.minLen != null) ov.lexicon = { ...(ov.lexicon ?? {}), minLen: Number(body.minLen) };
      if (body.minFreq != null) ov.lexicon = { ...(ov.lexicon ?? {}), minFreq: Number(body.minFreq) };
      const res = runDigest({
        cwd,
        inputs: inputs.map((p) => resolve(cwd, p)),
        wordlist: body.wordlist ? String(body.wordlist) : undefined,
        configOverrides: ov,
        localConfigPath: opts.localConfigPath,
        title: body.title ? String(body.title) : undefined,
        videoUrl: body.link ? String(body.link) : undefined,
        videoTitle: body.title ? String(body.title) : undefined,
      });
      return {
        ok: Boolean(res.verify?.ok),
        message: `运行 ${res.runId} 完成：${res.stats?.keptCount ?? 0} 个词条，自检${res.verify?.ok ? '通过' : '未通过'}`,
        runId: res.runId,
        docx: res.outputs?.docx ?? '',
        stats: res.stats ?? {},
        tags: res.tags ?? {},
      };
    },
    'POST /api/run/build': async (_req, _url, body) => {
      const runDir = join(cfgOf().runRoot, String(body.runId ?? ''));
      if (!existsSync(join(runDir, 'digest.json'))) return { ok: false, message: '运行不存在' };
      const ov = {};
      if (body.by) ov.classify = { by: String(body.by).split(',').map((s) => s.trim()).filter(Boolean) };
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
      const word = String(body.word ?? '').trim().toLowerCase();
      if (!word) return { ok: false, message: '缺少单词' };
      const patch = {};
      if (body.pos) patch.pos = String(body.pos);
      if (body.meaning != null) patch.meaning = String(body.meaning);
      cur[word] = { ...(cur[word] ?? {}), ...patch };
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
      ok({ server, port: p, url: `http://${host}:${p}/` });
    });
  });
}
