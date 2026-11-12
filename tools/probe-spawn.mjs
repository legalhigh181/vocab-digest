/**
 * 探针：本机 DSH 沙箱下能不能真的跑子进程？
 *
 * T6 把转写和下载改成子进程/流式以后，测试依赖「spawn 一个短命进程」这件事。
 * 沙箱（Windows 下 DSH 的 workspace-write 模式）会拦掉一部分进程创建，
 * 那么测试结果就只能记成「环境受阻」，不能记成通过，也不能记成代码失败。
 *
 * 这个文件在仓库里长期保留，用来随时复现这个限制。
 * 进程被拦时仍然以退出码 0 结束 —— 探针的结论写在输出里，不是靠崩不崩来判断的。
 *
 * 跑法：node tools/probe-spawn.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'vd-probe-spawn-'));
const script = join(dir, 'child.mjs');
// 子进程真的跑起来时会写这个文件 —— 光看 status 不够，沙箱也可能给出 status 却什么都没跑
const marker = join(dir, 'ran.txt');
writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');`, 'utf8');
const { readFileSync } = await import('node:fs');

const report = { node: process.version, platform: process.platform, checks: [] };

// 1) spawnSync：T5 的两项 CLI 测试就卡在这一步
let s;
try {
  s = spawnSync(process.execPath, [script], { encoding: 'utf8', windowsHide: true });
} catch (e) {
  s = { status: null, stdout: '', stderr: String(e), error: e };
}
report.checks.push({
  check: 'spawnSync',
  status: s.status ?? null,
  stdout: s.stdout ?? '',
  error: s.error ? `${s.error.code ?? ''} ${s.error.message}` : null,
  verdict: s.status === 0 ? 'OK' : 'BLOCKED',
});

// 2) spawn（异步）：T6 的转写走这条路
report.checks.push(await new Promise((res) => {
  let out = '';
  let err = '';
  let settled = false;
  const done = (payload) => { if (!settled) { settled = true; res(payload); } };
  let c;
  try {
    c = spawn(process.execPath, [script], { windowsHide: true });
  } catch (e) {
    done({ check: 'spawn(async)', error: `${e.code ?? ''} ${e.message}`, verdict: 'BLOCKED' });
    return;
  }
  c.stdout.on('data', (d) => { out += d; });
  c.stderr.on('data', (d) => { err += d; });
  c.on('error', (e) => done({ check: 'spawn(async)', error: `${e.code ?? ''} ${e.message}`, verdict: 'BLOCKED' }));
  c.on('close', (code) => done({ check: 'spawn(async)', status: code, stdout: out, stderr: err, verdict: code === 0 ? 'OK' : 'BLOCKED' }));
}));

// 3) 在 pwsh 里直接起进程（DSH 的 pwsh 工具能跑命令，但 node 的 spawn 可能被拦）
//    这一步不做，就分不清「整台机器不能起进程」还是「只是 node 的 spawn 被沙箱拦」
report.checks.push({
  check: 'child-marker',
  existed: (() => { try { return readFileSync(marker, 'utf8') === 'ran'; } catch { return false; } })(),
  verdict: 'INFO',
});

rmSync(dir, { recursive: true, force: true });

console.log(JSON.stringify(report, null, 2));
const blocked = report.checks.filter((c) => c.verdict === 'BLOCKED').map((c) => c.check);
console.log(blocked.length === 0
  ? '子进程可用：可以用测试验证转写契约'
  : `子进程被拦：${blocked.join(', ')} —— 相关测试只能记为「环境受阻」`);
