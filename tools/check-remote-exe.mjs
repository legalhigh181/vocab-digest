// 查 GitHub 公开仓库里有没有坏 exe / 构建产物残留。不需要 token。
const repo = 'legalhigh181/vocab-digest';
const H = { Accept: 'application/vnd.github+json', 'User-Agent': 'vocab-digest-check' };

async function get(url) {
  const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(30000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}\n${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// 1. 仓库源码树（默认分支 main）
const info = await get(`https://api.github.com/repos/${repo}`);
const branch = info.default_branch;
console.log('默认分支：', branch);

const tree = await get(`https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`);
const blobs = (tree.tree || []).filter((x) => x.type === 'blob');
console.log('仓库文件数：', blobs.length, `（被截断：${tree.truncated}）`);

console.log('\n=== 仓库里有没有 exe / build / .bad / vocab-client ===');
const suspicious = blobs.filter((f) =>
  /\.exe/i.test(f.path) || /^build\//i.test(f.path) || /\.bad$/i.test(f.path) || /vocab-client/i.test(f.path));
if (suspicious.length) {
  for (const f of suspicious) console.log('  !', f.path, `(${f.size} 字节)`);
} else {
  console.log('  无 ✓');
}

// 2. Release 附件
console.log('\n=== Release v1.0 附件 ===');
try {
  const rel = await get(`https://api.github.com/repos/${repo}/releases/tags/v1.0`);
  for (const a of rel.assets) {
    console.log('  ', a.name, (a.size / 1024 / 1024).toFixed(2) + ' MB');
  }
} catch (e) {
  console.log('  读不到：', e.message.split('\n')[0]);
}

console.log('\n=== 结论 ===');
for (const [label, test] of [
  ['仓库里有 exe', (f) => /\.exe$/i.test(f.path)],
  ['仓库里有 .bad', (f) => /\.bad$/i.test(f.path)],
  ['仓库里有 build/', (f) => /^build\//i.test(f.path)],
]) {
  console.log(`  ${label}：`, blobs.some(test) ? '有 ✗' : '无 ✓');
}
