/**
 * OOXML（WordprocessingML）最小生成器。
 *
 * 只覆盖本项目需要的元素：段落 / 字符样式 / 标题 / 项目符号 / 目录域 / 表格。
 * 不依赖任何第三方库，输出可被 Word / WPS / LibreOffice 打开。
 */

export const NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
export const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

export function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // XML 1.0 不允许的控制字符（弹幕里偶尔混进 0x00-0x08）
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

/**
 * 一个文字 run。
 * @param {string} text
 * @param {object} opts { bold, italic, size(半磅), color, font, eastAsia }
 *
 * `eastAsia` 单独一项：`font` 是「西文也用这个字体」，`eastAsia` 只改亚洲字形。
 * 日文正文走 `eastAsia: 'Meiryo'`，拉丁字母仍按样式里的 Calibri 走 ——
 * 只写 `font` 会把拼音/数字也换成日文字体，英文词条那一半就变样了。
 * 两个都给时 eastAsia 优先（调用方显式指定亚洲字体）。
 */
export function run(text, opts = {}) {
  const props = [];
  if (opts.font || opts.eastAsia) {
    const ascii = opts.font ? escapeXml(opts.font) : '';
    const ea = escapeXml(opts.eastAsia ?? opts.font);
    const attrs = [];
    if (ascii) attrs.push(`w:ascii="${ascii}" w:hAnsi="${ascii}"`);
    attrs.push(`w:eastAsia="${ea}"`);
    props.push(`<w:rFonts ${attrs.join(' ')}/>`);
  }
  if (opts.bold) props.push('<w:b/>');
  if (opts.italic) props.push('<w:i/>');
  if (opts.color) props.push(`<w:color w:val="${escapeXml(opts.color)}"/>`);
  if (opts.size) props.push(`<w:sz w:val="${opts.size}"/><w:szCs w:val="${opts.size}"/>`);
  const rPr = props.length ? `<w:rPr>${props.join('')}</w:rPr>` : '';
  // 保留空格：前导/尾随空白需要 xml:space
  const t = `<w:t xml:space="preserve">${escapeXml(text)}</w:t>`;
  return `<w:r>${rPr}${t}</w:r>`;
}

/**
 * 外部超链接。rId 是本包 word/_rels/document.xml.rels 里的关系 id。
 * 链接文字用蓝色下划线，Word 里 Ctrl+点即可打开。
 */
export function hyperlinkRun(text, rId, opts = {}) {
  const rPr = '<w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr>';
  const t = `<w:t xml:space="preserve">${escapeXml(text)}</w:t>`;
  return `<w:hyperlink r:id="${escapeXml(rId)}" w:history="1"><w:r>${rPr}${t}</w:r></w:hyperlink>`;
}

/**
 * 段落。
 * @param {string[]} runs 已序列化的 run 字符串
 * @param {object} opts { style, indLeft(缇), spaceBefore, spaceAfter, align, pageBreak }
 */
export function para(runs, opts = {}) {
  const pPr = [];
  if (opts.style) pPr.push(`<w:pStyle w:val="${escapeXml(opts.style)}"/>`);
  if (opts.pageBreak) pPr.push('<w:pageBreakBefore/>');
  if (opts.align) pPr.push(`<w:jc w:val="${escapeXml(opts.align)}"/>`);
  if (opts.spaceBefore || opts.spaceAfter) {
    const attrs = [];
    if (opts.spaceBefore) attrs.push(`w:before="${opts.spaceBefore}"`);
    if (opts.spaceAfter) attrs.push(`w:after="${opts.spaceAfter}"`);
    pPr.push(`<w:spacing ${attrs.join(' ')}/>`);
  }
  if (opts.indLeft) pPr.push(`<w:ind w:left="${opts.indLeft}"/>`);
  const inner = pPr.length ? `<w:pPr>${pPr.join('')}</w:pPr>` : '';
  const list = Array.isArray(runs) ? runs : [runs];
  return `<w:p>${inner}${list.join('')}</w:p>`;
}

/** 项目符号段落（引用 numbering.xml 的 numId=1） */
export function bulletPara(runs, opts = {}) {
  const list = Array.isArray(runs) ? runs : [runs];
  const pPr = `<w:pPr><w:pStyle w:val="ListBullet"/><w:numPr><w:ilvl w:val="${opts.level ?? 0}"/><w:numId w:val="1"/></w:numPr></w:pPr>`;
  return `<w:p>${pPr}${list.join('')}</w:p>`;
}

export function pageBreak() {
  return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
}

/**
 * 目录域（TOC）。Word 打开时会提示更新域（settings 里 updateFields=true 会自动刷新）。
 * 占位文字在刷新前可见。
 */
export function tocField(opts = {}) {
  const levels = opts.levels ?? '1-3';
  const placeholder = opts.placeholder ?? '（目录将在 Word 打开时自动生成）';
  return [
    '<w:p><w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r>',
    `<w:r><w:instrText xml:space="preserve"> TOC \\o "${levels}" \\h \\z \\u </w:instrText></w:r>`,
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>',
    run(placeholder),
    '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>',
  ].join('');
}

/**
 * 表格。
 * @param {string[]} headers
 * @param {string[][]} rows
 * @param {object} opts { widths:number[] (缇), headerStyle, cellStyle, font, eastAsia }
 */
export function table(headers, rows, opts = {}) {
  const colCount = Math.max(headers.length, ...rows.map((r) => r.length), 1);
  const borders = '<w:tblBorders>'
    + '<w:top w:val="single" w:sz="4" w:space="0" w:color="B0B0B0"/>'
    + '<w:left w:val="single" w:sz="4" w:space="0" w:color="B0B0B0"/>'
    + '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="B0B0B0"/>'
    + '<w:right w:val="single" w:sz="4" w:space="0" w:color="B0B0B0"/>'
    + '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="D0D0D0"/>'
    + '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="D0D0D0"/>'
    + '</w:tblBorders>';
  const grid = Array.from({ length: colCount }, (_, i) => {
    const w = opts.widths?.[i];
    return `<w:gridCol${w ? ` w:w="${w}"` : ''}/>`;
  }).join('');
  const cell = (text, isHeader) => {
    const shade = isHeader ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>' : '';
    const style = `<w:pPr><w:pStyle w:val="TableText"/></w:pPr>`;
    // 表格里同样会有日文（词形、读音），东亚字体要跟着语言走
    const body = escapeXml(text) ? run(text, { bold: isHeader, eastAsia: opts.eastAsia }) : '';
    return `<w:tc><w:tcPr>${shade}</w:tcPr><w:p>${style}${body}</w:p></w:tc>`;
  };
  const headerRow = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${headers.map((h) => cell(h, true)).join('')}</w:tr>`;
  const bodyRows = rows
    .map((r) => {
      const cells = [];
      for (let i = 0; i < colCount; i += 1) cells.push(cell(r[i] ?? '', false));
      return `<w:tr>${cells.join('')}</w:tr>`;
    })
    .join('');
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/>${borders}</w:tblPr>`
    + `<w:tblGrid>${grid}</w:tblGrid>${headerRow}${bodyRows}</w:tbl>`
    + '<w:p/>';
}

// ── 包内其余部件 ───────────────────────────────────────────────────────

export function contentTypes() {
  return XML_DECL + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>'
    + '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
    + '</Types>';
}

export function rels() {
  return XML_DECL + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
    + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
    + '</Relationships>';
}

/**
 * document.xml 的关系表。
 * @param {Array<{id:string,url:string}>} links 外部超链接（剑桥等词典）
 */
export function documentRels(links = []) {
  const ext = links.map((l) =>
    `<Relationship Id="${escapeXml(l.id)}" Type="${NS_R}/hyperlink" Target="${escapeXml(l.url)}" TargetMode="External"/>`);
  return XML_DECL + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + `<Relationship Id="rId1" Type="${NS_R}/styles" Target="styles.xml"/>`
    + `<Relationship Id="rId2" Type="${NS_R}/settings" Target="settings.xml"/>`
    + `<Relationship Id="rId3" Type="${NS_R}/numbering" Target="numbering.xml"/>`
    + ext.join('')
    + '</Relationships>';
}

export function numbering() {
  return XML_DECL + `<w:numbering xmlns:w="${NS_W}">`
    + '<w:abstractNum w:abstractNumId="0">'
    + '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="\u2022"/>'
    + '<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="420" w:hanging="420"/></w:pPr>'
    + '<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/></w:rPr></w:lvl>'
    + '<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="\u25E6"/>'
    + '<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="840" w:hanging="420"/></w:pPr></w:lvl>'
    + '</w:abstractNum>'
    + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
    + '</w:numbering>';
}

export function settings() {
  return XML_DECL + `<w:settings xmlns:w="${NS_W}">`
    + '<w:updateFields w:val="true"/>'
    + '<w:defaultTabStop w:val="420"/>'
    + '<w:characterSpacingControl w:val="compressPunctuation"/>'
    + '<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>'
    + '</w:settings>';
}

function styleDef(id, name, opts = {}) {
  const pPr = [];
  if (opts.outline !== undefined) pPr.push(`<w:outlineLvl w:val="${opts.outline}"/>`);
  if (opts.spacing) pPr.push(opts.spacing);
  if (opts.keepNext) pPr.push('<w:keepNext/>');
  if (opts.ind) pPr.push(opts.ind);
  const rPr = [];
  if (opts.font) rPr.push(`<w:rFonts w:ascii="${opts.font}" w:hAnsi="${opts.font}" w:eastAsia="${opts.fontCn ?? opts.font}"/>`);
  if (opts.bold) rPr.push('<w:b/>');
  if (opts.size) rPr.push(`<w:sz w:val="${opts.size}"/><w:szCs w:val="${opts.size}"/>`);
  if (opts.color) rPr.push(`<w:color w:val="${opts.color}"/>`);
  const pPrXml = pPr.length ? `<w:pPr>${pPr.join('')}</w:pPr>` : '';
  const rPrXml = rPr.length ? `<w:rPr>${rPr.join('')}</w:rPr>` : '';
  const based = opts.basedOn ? `<w:basedOn w:val="${opts.basedOn}"/>` : '';
  return `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>${based}${pPrXml}${rPrXml}</w:style>`;
}

export function styles({ fontCn = '等线', fontEn = 'Calibri', lang = 'zh-CN', eastAsiaLang = null } = {}) {
  // fontCn 在这里就是「亚洲字形用哪个字体」：中文默认等线，日文由调用方传 Meiryo。
  // 日文文档还要把 eastAsia 语言标成 ja-JP，否则 Word 会拿中文字形凑合着排假名。
  const ea = eastAsiaLang
    ? escapeXml(eastAsiaLang)
    : escapeXml(lang ?? 'zh-CN');
  const langXml = `<w:lang w:val="en-US" w:eastAsia="${ea}"/>`;
  const body = styleDef('Normal', 'Normal', {
    font: fontEn, fontCn, size: 21,
    spacing: '<w:spacing w:line="320" w:lineRule="auto" w:after="80"/>',
  });
  const title = styleDef('Title', 'Title', {
    basedOn: 'Normal', font: fontEn, fontCn, bold: true, size: 48, color: '1F3864',
    spacing: '<w:spacing w:before="2400" w:after="240" w:line="360" w:lineRule="auto"/>',
  }).replace('</w:style>', '<w:pPr><w:jc w:val="center"/></w:pPr></w:style>');
  const subtitle = styleDef('Subtitle', 'Subtitle', {
    basedOn: 'Normal', font: fontEn, fontCn, size: 24, color: '595959',
    spacing: '<w:spacing w:before="120" w:after="120"/>',
  }).replace('</w:style>', '<w:pPr><w:jc w:val="center"/></w:pPr></w:style>');
  const h1 = styleDef('Heading1', 'heading 1', {
    basedOn: 'Normal', font: fontEn, fontCn, bold: true, size: 32, color: '1F3864',
    outline: 0, keepNext: true,
    spacing: '<w:spacing w:before="360" w:after="160" w:line="300" w:lineRule="auto"/>',
  });
  const h2 = styleDef('Heading2', 'heading 2', {
    basedOn: 'Normal', font: fontEn, fontCn, bold: true, size: 26, color: '2E5496',
    outline: 1, keepNext: true,
    spacing: '<w:spacing w:before="280" w:after="100"/>',
  });
  const h3 = styleDef('Heading3', 'heading 3', {
    basedOn: 'Normal', font: fontEn, fontCn, bold: true, size: 22, color: '2E5496',
    outline: 2, keepNext: true,
    spacing: '<w:spacing w:before="200" w:after="80"/>',
  });
  const caption = styleDef('Caption', 'caption', {
    basedOn: 'Normal', font: fontEn, fontCn, size: 18, color: '7F7F7F',
    spacing: '<w:spacing w:before="40" w:after="200"/>',
  });
  const listBullet = styleDef('ListBullet', 'List Bullet', {
    basedOn: 'Normal', font: fontEn, fontCn, size: 20,
    spacing: '<w:spacing w:after="40"/>', ind: '<w:ind w:left="420" w:hanging="420"/>',
  });
  const tableText = styleDef('TableText', 'Table Text', {
    basedOn: 'Normal', font: fontEn, fontCn, size: 19,
    spacing: '<w:spacing w:after="0" w:line="260" w:lineRule="auto"/>',
  });
  const quote = styleDef('Quote', 'Quote', {
    basedOn: 'Normal', font: fontEn, fontCn, size: 20, color: '595959',
    spacing: '<w:spacing w:before="60" w:after="60"/>', ind: '<w:ind w:left="360"/>',
  });

  return XML_DECL + `<w:styles xmlns:w="${NS_W}">`
    + '<w:docDefaults><w:rPrDefault><w:rPr>'
    + `<w:rFonts w:ascii="${fontEn}" w:hAnsi="${fontEn}" w:eastAsia="${fontCn}" w:cs="${fontEn}"/>`
    + `<w:sz w:val="21"/><w:szCs w:val="21"/>${langXml}`
    + '</w:rPr></w:rPrDefault>'
    + '<w:pPrDefault><w:pPr><w:spacing w:after="80"/></w:pPr></w:pPrDefault>'
    + '</w:docDefaults>'
    + body + title + subtitle + h1 + h2 + h3 + caption + listBullet + tableText + quote
    + '</w:styles>';
}

export function coreProps({ title = '', created = new Date() } = {}) {
  const iso = created.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return XML_DECL
    + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"'
    + ' xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"'
    + ' xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    + `<dc:title>${escapeXml(title)}</dc:title>`
    + '<dc:creator>vocab-digest</dc:creator>'
    + `<dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created>`
    + `<dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified>`
    + '</cp:coreProperties>';
}

export function appProps() {
  return XML_DECL
    + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"'
    + ' xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
    + '<Application>vocab-digest</Application>'
    + '</Properties>';
}

/** 组装 document.xml 外壳 */
export function document(bodyXml) {
  return `${XML_DECL}<w:document xmlns:w="${NS_W}" xmlns:r="${NS_R}"><w:body>${bodyXml}`
    + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
    + '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/>'
    + '</w:sectPr></w:body></w:document>';
}

/** 包内全部部件；links 为文档里的外部超链接 */
export function buildParts(documentXml, { title, fontCn, fontEn, lang, eastAsiaLang, created, links } = {}) {
  return [
    { name: '[Content_Types].xml', data: contentTypes() },
    { name: '_rels/.rels', data: rels() },
    { name: 'word/document.xml', data: documentXml },
    { name: 'word/styles.xml', data: styles({ fontCn, fontEn, lang, eastAsiaLang }) },
    { name: 'word/settings.xml', data: settings() },
    { name: 'word/numbering.xml', data: numbering() },
    { name: 'word/_rels/document.xml.rels', data: documentRels(links) },
    { name: 'docProps/core.xml', data: coreProps({ title, created: created ?? new Date() }) },
    { name: 'docProps/app.xml', data: appProps() },
  ];
}
