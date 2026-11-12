// 从 cards.json 的实际卡片数重算某张（或全部）词表的 count，并写回索引与 meta.json。
//
// 背景：T4 之前 touch() 有调用点传的是 {count: n} 对象，落盘成对象后被归零，
// 导致索引里的 count 与实际卡片数脱节。normalizeCount 只能防住未来，
// 历史数据必须靠实际卡片数重算 —— 不能靠猜。
import fs from 'node:fs';
import { join } from 'node:path';

const arg = process.argv[2] || '';
const root = join('data', 'wordlists');
const indexFile = join(root, '索引.json');

if (!fs.existsSync(indexFile)) {
  console.log('没有 索引.json，跳过');
  process.exit(0);
}

const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
const targets = arg ? index.lists.filter((l) => l.id === arg) : index.lists;
if (arg && !targets.length) {
  console.error(`找不到词表：${arg}`);
  process.exit(1);
}

let changed = 0;
for (const entry of targets) {
  const dir = join(root, entry.id);
  const cardsFile = join(dir, 'cards.json');
  let actual = 0;
  let readable = true;
  if (fs.existsSync(cardsFile)) {
    try {
      const payload = JSON.parse(fs.readFileSync(cardsFile, 'utf8'));
      actual = Array.isArray(payload.cards) ? payload.cards.length : 0;
    } catch {
      readable = false;
    }
  }

  const before = entry.count;
  const beforeIsNumber = typeof before === 'number' && Number.isFinite(before);

  if (!readable) {
    console.log(`  ${entry.id}：cards.json 解析失败，跳过（不动 count=${JSON.stringify(before)}）`);
    continue;
  }

  if (!beforeIsNumber || before !== actual) {
    entry.count = actual;
    const reason = beforeIsNumber ? '数量不符' : `历史脏值 ${JSON.stringify(before)}`;
    console.log(`  ${entry.id}：count ${JSON.stringify(before)} → ${actual}（${reason}）`);
    changed += 1;
  } else {
    console.log(`  ${entry.id}：count=${actual} 正确，不动`);
  }

  // meta.json 同步
  const metaFile = join(dir, 'meta.json');
  if (fs.existsSync(metaFile)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      if (meta.count !== actual) {
        meta.count = actual;
        fs.writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
      }
    } catch {
      console.log(`     meta.json 解析失败，跳过`);
    }
  }
}

if (changed) {
  fs.writeFileSync(indexFile, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  console.log(`\n已更新索引，重算 ${changed} 张表`);
} else {
  console.log('\n没有需要重算的词表');
}
