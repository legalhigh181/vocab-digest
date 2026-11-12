/**
 * 落盘：文档模型 → docx 字节。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildDocumentXml, collectLinks } from './build.js';
import { makeZip } from './zip.js';
import { buildParts } from './ooxml.js';

const FIXED_DATE = new Date(Date.UTC(2020, 0, 1, 0, 0, 0));

/**
 * 只渲染，不写盘。
 * @returns {{ documentXml:string, zip:Buffer, parts:Array }}
 */
export function renderDocx(doc, opts = {}) {
  // 超链接关系表必须在生成 document.xml 之前就定下来（词条里要引用 rId）
  const links = opts.links ?? collectLinks(doc);
  const documentXml = buildDocumentXml(doc, { ...opts, links });
  const linkList = [...links].map(([url, id]) => ({ id, url }));
  const parts = buildParts(documentXml, {
    title: doc.title,
    fontCn: opts.fontCn,
    fontEn: opts.fontEn,
    // 语言相关的排版：fontCn 在这里是「亚洲字形字体」，eastAsiaLang 是 styles 里的 w:lang
    lang: opts.lang,
    eastAsiaLang: opts.eastAsiaLang,
    created: opts.fixedTimestamp === false ? new Date() : FIXED_DATE,
    links: linkList,
  });
  const zip = makeZip(parts, { date: opts.fixedTimestamp === false ? new Date() : FIXED_DATE });
  return { documentXml, zip, parts, links };
}

/**
 * 渲染并写盘。
 * @returns {{ outPath:string, bytes:number, documentXml:string, zip:Buffer }}
 */
export function writeDocx(outPath, doc, opts = {}) {
  const { documentXml, zip, links } = renderDocx(doc, opts);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, zip);
  return { outPath, bytes: zip.length, documentXml, zip, links };
}
