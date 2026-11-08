// 探针：用 token 调 GitHub API，看出到底是哪项权限不够。
// 用法：node tools/probe-token.mjs <token>
const tok = process.argv[2];
if (!tok) {
  console.error('缺少 token');
  process.exit(1);
}

const H = {
  Authorization: `Bearer ${tok}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'vocab-digest-probe',
};

const repo = 'legalhigh181/vocab-digest';

async function call(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: { ...H, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, ok: r.ok, scopes: r.headers.get('x-oauth-scopes'), body: json ?? text.slice(0, 300) };
}

const me = await call('GET', 'https://api.github.com/user');
console.log('1) GET /user              ->', me.status, 'login =', me.body?.login, '| scopes =', me.scopes);

const r = await call('GET', `https://api.github.com/repos/${repo}`);
console.log('2) GET /repos             ->', r.status, '| permissions =', JSON.stringify(r.body?.permissions ?? null));

const perms = await call('GET', `https://api.github.com/repos/${repo}/actions/permissions`);
console.log('3) GET actions/permissions ->', perms.status, perms.ok ? '' : JSON.stringify(perms.body).slice(0, 200));

// 写权限探测：创建一条 blob（content 权限需要 write）
const blob = await call('POST', `https://api.github.com/repos/${repo}/git/blobs`, {
  content: 'probe',
  encoding: 'utf-8',
});
console.log('4) POST git/blobs (write) ->', blob.status, blob.ok ? 'WRITE OK' : JSON.stringify(blob.body).slice(0, 300));
