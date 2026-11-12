// 用 GitHub Release API 上传 zip。
// 用法：node tools/make-release.mjs <token>
import fs from 'node:fs';
import path from 'node:path';

const tok = process.argv[2];
const repo = 'legalhigh181/vocab-digest';
const tag = 'v1.0';
const H = {
  Authorization: `Bearer ${tok}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'vocab-digest-release',
  'Content-Type': 'application/json',
};

const ZIP = path.resolve('dist/词汇库-v1.0-windows.zip');

if (!fs.existsSync(ZIP)) {
  console.error('找不到 zip：', ZIP);
  process.exit(1);
}

const body = {
  tag_name: tag,
  name: '词汇库 v1.0',
  body: [
    '把 B 站英语视频的弹幕、字幕整理成一份按词性分类的英语单词 Word 文档。',
    '',
    '## 下载',
    '`词汇库-v1.0-windows.zip`（约 2.2 MB）',
    '',
    '## 怎么用',
    '1. 解压到一个**路径不含中文**的文件夹（比如 `D:\\词汇库\\`）',
    '2. 双击 `安装.cmd`（需要先装 [Node.js 20+](https://nodejs.org/zh-cn/download)）',
    '3. 之后双击桌面的「词汇库」就能用',
    '',
    '详细步骤见压缩包里的 `使用说明.md`。',
    '',
    '## 不含',
    '- 英汉词典（66 MB）：双击 `下载词典.cmd` 自己下，或者直接用词条上的「剑桥」链接在线查',
    '- 语音识别模型（465 MB）：只有视频没字幕时才需要',
  ].join('\n'),
  draft: false,
  prerelease: false,
};

async function api(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}\n${text.slice(0, 500)}`);
  return json;
}

// 1. 已有就删掉重来（保证可以重复运行）
try {
  const old = await api(`https://api.github.com/repos/${repo}/releases/tags/${tag}`);
  console.log('已有 release', old.id, '先删除');
  await api(`https://api.github.com/repos/${repo}/releases/${old.id}`, { method: 'DELETE' });
} catch (e) {
  if (!String(e.message).includes('404')) throw e;
}

// 2. 建 release
const rel = await api(`https://api.github.com/repos/${repo}/releases`, {
  method: 'POST',
  body: JSON.stringify(body),
});
console.log('release id', rel.id, rel.html_url);

// 3. 上传 zip
const name = path.basename(ZIP);
const data = fs.readFileSync(ZIP);
const upload = await api(
  `https://uploads.github.com/repos/${repo}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip', 'Content-Length': String(data.length) },
    body: data,
  },
);
console.log('上传完成', upload.name, upload.size, 'bytes');
console.log('下载地址：', upload.browser_download_url);
