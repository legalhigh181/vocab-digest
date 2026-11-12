// 用 GitHub API 核对远端仓库内容，确认推送上去的东西是干净的。
// 用法：node tools/verify-remote.mjs <token>
const tok = process.argv[2];
const repo = 'legalhigh181/vocab-digest';
const H = {
  Authorization: `Bearer ${tok}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'vocab-digest-verify',
};

const FORBIDDEN = [
  ['个人词表', /(^|\/)data\/wordlists\//],
  ['运行记录', /(^|\/)runs\//],
  ['样本数据', /(^|\/)samples\//],
  ['调试脚本', /(^|\/)scratch-/],
  ['可执行文件', /\.exe$/i],
  // 词典/模型只看数据文件，不看读它的代码（src/lexicon/ecdict.js 是正常的）
  ['ECDICT 词典数据', /(^|\/)ecdict\.(csv|sqlite|db)$/i],
  ['whisper 模型', /ggml.*\.bin$/i],
  ['素材原图', /-sheet\.png$/i],
  ['UI 版本快照', /(^|\/)versions\//],
  ['打包产物', /(^|\/)dist\//],
  ['exe 中间产物', /(^|\/)build\//],
];

const b = await (await fetch(`https://api.github.com/repos/${repo}/branches/main`, { headers: H })).json();
console.log('分支 main 最新提交:', b.commit.sha.slice(0, 7));
console.log('提交说明:', b.commit.commit.message.split('\n')[0]);

const t = await (await fetch(`https://api.github.com/repos/${repo}/git/trees/main?recursive=1`, { headers: H })).json();
const blobs = t.tree.filter((x) => x.type === 'blob');
console.log('远端文件数:', blobs.length);

const dirs = {};
for (const f of blobs) {
  const d = f.path.includes('/') ? f.path.split('/')[0] : '(根目录)';
  dirs[d] = (dirs[d] || 0) + 1;
}
console.log('按目录:', Object.entries(dirs).map(([k, v]) => `${k}=${v}`).join('  '));

let clean = true;
for (const [name, re] of FORBIDDEN) {
  const hit = blobs.filter((f) => re.test(f.path));
  if (hit.length) {
    clean = false;
    console.log(`  ✗ ${name}: ${hit.slice(0, 5).map((f) => f.path).join(', ')}${hit.length > 5 ? ` …共${hit.length}` : ''}`);
  }
}
console.log(clean ? '敏感文件残留: 无 ✓' : '敏感文件残留: 有问题 ✗');

const total = blobs.reduce((s, f) => s + (f.size || 0), 0);
console.log('远端总体积:', (total / 1024 / 1024).toFixed(2), 'MB');
