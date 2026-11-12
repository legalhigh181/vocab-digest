// 探针：日文运行里「日本」的实际读音，以及 /api/wordlist/add 的失败原因
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDigestAsync } from '../src/run.js';
import { startApp } from '../src/app/server.js';

const cwd = mkdtempSync(join(tmpdir(), 'probe-t6-'));
const jaSrt = join(cwd, 'ja.srt');
writeFileSync(jaSrt, ['1', '00:00:01,000 --> 00:00:04,000', '日本の学生は毎日勉強します。', ''].join('\r\n'), 'utf8');
const r = await runDigestAsync({ inputs: [jaSrt], cwd, runId: 'p1', language: 'ja' });
console.log('run keys:', Object.keys(r).join(','));
const items = r.items ?? r.sections?.flatMap((s) => s.items ?? []) ?? r.result?.sections?.flatMap((s) => s.items ?? []) ?? [];
for (const it of items) {
  console.log(JSON.stringify({ word: it.word, display: it.display, reading: it.reading, hira: it.readingHiragana, pos: it.pos, unknown: it.unknown, count: it.count }));
}

const app = await startApp({ cwd, port: 0 });
const j = async (p, b) => {
  const res = await fetch(new URL(p, app.url), b ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) } : {});
  return res.json();
};
const created = await j('/api/wordlist/create', { name: '日表', language: 'ja' });
console.log('create:', JSON.stringify(created));
const add = await j('/api/wordlist/add', {
  id: created.listId,
  cards: [{ word: '日本', display: '日本', language: 'ja', entryKey: 'ja|日本|ニホン|prop.', reading: 'ニホン', readingHiragana: 'にほん', unknown: false, senses: [{ pos: 'prop.', meaning: '日本' }] }],
});
console.log('add:', JSON.stringify(add));
const cards = await j('/api/wordlist/cards', { id: created.listId });
console.log('cards:', JSON.stringify(cards));
app.server.close();
