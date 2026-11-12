import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transcribe } from '../src/asr.js';

const dir = mkdtempSync(join(tmpdir(), 'dbg-'));
mkdirSync(join(dir, 'models'), { recursive: true });
const model = join(dir, 'models', 'ggml-small.bin');
const input = join(dir, 'a.m4s');
writeFileSync(model, 'x'); writeFileSync(input, 'x');
const out = join(dir, 'out', 'a.srt');

const r = await transcribe({
  input, out, cwd: dir, model, overwrite: true,
  stageRoot: join(dir, 'stage'),
  ffmpegCmd: 'fake',
  ffmpegTarget: async (cmd, args, o) => {
    const af = args[args.indexOf('-af') + 1];
    const m = /(?:^|[:,])destination=([^,:]+)/.exec(af);
    console.log('match=', m && m[1]);
    const abs = join(o.cwd, m[1]);
    console.log('abs=', abs);
    mkdirSync(join(abs, '..'), { recursive: true }).valueOf?.();
    writeFileSync(abs, '1\n00:00:00,000 --> 00:00:01,000\nhi\n');
    console.log('wrote, exists=', existsSync(abs));
    return { status: 0, stderr: '', stderrDropped: 0, timedOut: false, cancelled: false, elapsedMs: 1, spawnError: null };
  },
}).catch((e) => ({ err: e.code + ' / ' + e.message }));
console.log('RESULT=', r && r.err ? r.err : 'ok');
rmSync(dir, { recursive: true, force: true });

import { existsSync } from 'node:fs';
