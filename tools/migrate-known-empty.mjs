// 一次性迁移：把历史上被 JSON 写成 `""` 的空 known.txt 改成真正的空文本。
// 只动「内容等价于空」的文件（""/[]/null），有实际词的 known.txt 一律不碰。
import fs from 'node:fs';
import { join } from 'node:path';

const root = join('data', 'wordlists');
if (!fs.existsSync(root)) {
  console.log('没有 data/wordlists，跳过');
  process.exit(0);
}

const fixed = [];
for (const name of fs.readdirSync(root)) {
  const dir = join(root, name);
  if (!fs.statSync(dir).isDirectory() || name === '.trash') continue;
  const file = join(dir, 'known.txt');
  if (!fs.existsSync(file)) continue;
  const raw = fs.readFileSync(file, 'utf8');
  const trimmed = raw.trim();
  if (trimmed === '""' || trimmed === '[]' || trimmed === 'null') {
    fs.writeFileSync(file, '', 'utf8');
    fixed.push(`${name}：${JSON.stringify(raw)} → (空)`);
  }
}

if (fixed.length) {
  console.log('已修复：');
  for (const line of fixed) console.log('  ' + line);
} else {
  console.log('没有需要修复的空 known.txt');
}
