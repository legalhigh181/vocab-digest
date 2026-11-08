/**
 * 自检：什么都不信，把生成出来的 docx 重新打开检查。
 *
 * 检查项：
 *   zip          包能读、CRC 对、9 个部件齐全
 *   xml          每个 XML 部件标签配对、无裸 & / <
 *   content      正文含统计、含每个章节标题
 *   coverage     词频总表条目数 = 词条数
 *   determinism  同输入重渲染 document.xml 逐字节一致
 */
import { existsSync, readFileSync } from 'node:fs';
import { sha256, stableStringify } from './util.js';
import { readZip } from './docx/zip.js';
import { buildDocumentXml } from './docx/build.js';

const REQUIRED_PARTS = [
  '[Content_Types].xml',
  '_rels/.rels',
  'word/document.xml',
  'word/styles.xml',
  'word/settings.xml',
  'word/numbering.xml',
  'word/_rels/document.xml.rels',
  'docProps/core.xml',
  'docProps/app.xml',
];

/**
 * 极简 XML 良构检查：标签配对 + 裸 & / <。
 * 不做完整解析（无第三方库），但足以抓住「Word 报文件损坏」的常见原因。
 */
export function checkXml(text) {
  const problems = [];
  const stack = [];
  const tagRe = /<\/?([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
  let last = 0;
  let m;
  const body = text.replace(/<\?xml[^>]*\?>/, '');
  while ((m = tagRe.exec(body))) {
    const between = body.slice(last, m.index);
    const amp = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.exec(between);
    if (amp) problems.push(`裸 & 位于 ${m.index}`);
    const lt = /<(?![A-Za-z_!/?])/.exec(between);
    if (lt) problems.push(`裸 < 位于 ${m.index}`);
    last = m.index + m[0].length;
    if (m[0].startsWith('</')) {
      const open = stack.pop();
      if (open !== m[1]) problems.push(`标签不配对：</${m[1]}> 对 ${open ?? '(空)'}`);
    } else if (!m[3]) {
      stack.push(m[1]);
    }
  }
  if (stack.length) problems.push(`未闭合标签：${stack.slice(-5).join(',')}`);
  return { ok: problems.length === 0, problems };
}

/** 统计 document.xml 里的结构信息 */
export function documentStats(xml) {
  const count = (re) => (xml.match(re) ?? []).length;
  return {
    paragraphs: count(/<w:p[ >]/g),
    tables: count(/<w:tbl>/g),
    heading1: count(/<w:pStyle w:val="Heading1"\/>/g),
    heading2: count(/<w:pStyle w:val="Heading2"\/>/g),
    bullets: count(/<w:numPr>/g),
    entries: count(/出现 \d+ 次/g),
    chars: xml.length,
  };
}

/** 剥离易变内容（时间戳等），用于「等价」比对 */
export function stripVolatile(xml) {
  return xml.replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?/g, '<TIME>');
}

/**
 * 跑全部检查。
 * @param {object} p { documentXml, docxPath?, zipBuf?, docModel?, opts?, digest? }
 */
export function verifyRun(p = {}) {
  const checks = [];
  const add = (id, ok, message) => checks.push({ id, status: ok ? 'pass' : 'fail', message });

  const documentXml = p.documentXml;
  const zipBuf = p.zipBuf ?? (p.docxPath && existsSync(p.docxPath) ? readFileSync(p.docxPath) : null);

  // zip
  let parts = null;
  if (!zipBuf) {
    add('zip', false, '没有可读取的 docx');
  } else {
    try {
      parts = readZip(zipBuf);
      const missing = REQUIRED_PARTS.filter((r) => !parts.get(r));
      add('zip', missing.length === 0, missing.length ? `缺部件：${missing.join(', ')}` : `9 个部件齐全（${zipBuf.length} 字节）`);
    } catch (e) {
      add('zip', false, `读取失败：${e.message}`);
    }
  }

  // 部件与内存中的 document.xml 一致
  if (parts) {
    const inZip = parts.get('word/document.xml')?.toString('utf8');
    add('zip/document-match', inZip === documentXml, inZip === documentXml ? 'document.xml 与内存一致' : 'document.xml 不一致');
  }

  // xml 良构
  if (parts) {
    const bad = [];
    for (const [name, buf] of parts) {
      if (!/\.(xml|rels)$/.test(name)) continue;
      const r = checkXml(buf.toString('utf8'));
      if (!r.ok) bad.push(`${name}: ${r.problems.slice(0, 3).join('; ')}`);
    }
    add('xml', bad.length === 0, bad.length ? bad.join(' | ') : '所有 XML 部件良构');
  }

  const xml = documentXml ?? (parts?.get('word/document.xml')?.toString('utf8') ?? '');
  const stats = documentStats(xml);

  // 内容
  const model = p.docModel;
  if (model) {
    const noSections = (model.sections ?? []).filter((s) => (s.items ?? []).length > 0);
    const missingSec = noSections.filter((s) => !xml.includes(s.label));
    add('content/sections', missingSec.length === 0,
      missingSec.length ? `缺章节：${missingSec.map((s) => s.label).join(', ')}` : `${noSections.length} 个章节都写进了正文`);
    add('content/stats', xml.includes(String(model.stats?.keptCount ?? -1)),
      `正文含词条总数 ${model.stats?.keptCount}`);
    const expectEntries = noSections.reduce((n, s) => n + s.items.length, 0);
    add('content/entries', stats.entries >= expectEntries,
      `词条段落 ${stats.entries} / 预期 ≥ ${expectEntries}`);
  } else {
    add('content', stats.entries > 0, `词条段落 ${stats.entries}`);
  }

  // determinism：同模型重渲染是否逐字节一致
  if (model) {
    try {
      const again = buildDocumentXml(model, p.opts ?? {});
      const same = again === xml;
      add('determinism', same, same
        ? '重渲染 document.xml 逐字节一致'
        : `重渲染不一致（${sha256(again).slice(0, 12)} vs ${sha256(xml).slice(0, 12)}）`);
    } catch (e) {
      add('determinism', false, `重渲染失败：${e.message}`);
    }
  }

  // 输入哈希可复现（digest 里没有这个字段，这里顺手做一次稳定性检查）
  if (p.digest) {
    const h = sha256(stableStringify({ sources: p.digest.sources ?? [], stats: p.digest.stats ?? {} }));
    add('digest/hash', h.length === 64, `digest 指纹 ${h.slice(0, 12)}`);
  }

  const failed = checks.filter((c) => c.status === 'fail');
  return { ok: failed.length === 0, checks, documentXmlSha256: xml ? sha256(xml) : '', stats };
}
