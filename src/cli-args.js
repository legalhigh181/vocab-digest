/**
 * 极简参数解析：--key value / --flag / -k value，其余为位置参数。
 */
const BOOLEAN_FLAGS = ['json', 'help', 'force', 'no-toc', 'no-gpu', 'no-danmaku', 'with-danmaku', 'no-asr'];

export function parseArgs(argv) {
  const positional = [];
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 2) {
        args[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!BOOLEAN_FLAGS.includes(key) && next !== undefined && !next.startsWith('-')) {
        args[key] = next;
        i += 1;
      } else {
        args[key] = true;
      }
    } else if (a.startsWith('-') && a.length > 1) {
      const key = a.slice(1);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        args[key] = next;
        i += 1;
      } else {
        args[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  const cmd = positional.shift();
  return { cmd, positional, args };
}
