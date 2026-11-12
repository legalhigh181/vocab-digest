// 给已有的 release 重传附件（用 ASCII 文件名，避免中文被 GitHub 吃掉）
import fs from 'node:fs';
import path from 'node:path';

const tok = process.argv[2];
const repo = 'legalhigh181/vocab-digest';
const tag = 'v1.0';
// 上传时用 ASCII 名：GitHub 对 URL 里的中文文件名处理不可靠，会变成 "-v1.0-windows.zip"
const ASSET_NAME = 'vocab-digest-v1.0-windows.zip';
const ZIP = path.resolve('dist/词汇库-v1.0-windows.zip');

const H = {
  Authorization: `Bearer ${tok}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'vocab-digest-release',
};

async function api(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}\n${text.slice(0, 400)}`);
  return json;
}

const rel = await api(`https://api.github.com/repos/${repo}/releases/tags/${tag}`);
console.log('release', rel.id, rel.html_url);

// 删掉名字坏掉的旧附件
for (const a of rel.assets || []) {
  if (a.name !== ASSET_NAME) {
    console.log('删除旧附件', a.name);
    await api(`https://api.github.com/repos/${repo}/releases/assets/${a.id}`, { method: 'DELETE' });
  }
}

const data = fs.readFileSync(ZIP);
const upload = await api(
  `https://uploads.github.com/repos/${repo}/releases/${rel.id}/assets?name=${encodeURIComponent(ASSET_NAME)}`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip', 'Content-Length': String(data.length) },
    body: data,
  },
);
console.log('上传完成：', upload.name, upload.size, 'bytes');
console.log('下载地址：', upload.browser_download_url);
