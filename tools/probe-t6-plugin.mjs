// 探针：插件工具契约（只读，不触发任何运行）
// 注册到假的 tools 收集器里，逐个核对 parameters 的结构
import { apply } from '../src/index.js';

const tools = [];
const ctx = {
  // DSH 插件上下文用 ctx.get(name) 取服务；这里给一个最小实现
  get: (name) => (name === 'tools' ? { register: (t) => tools.push(t) } : undefined),
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  config: {},
};
await apply(ctx, {});

const lines = [];
lines.push(`注册工具数：${tools.length}`);
let bad = 0;
for (const t of tools) {
  const p = t.parameters ?? {};
  const props = p.properties ?? {};
  const required = p.required ?? [];
  const issues = [];
  if (p.type !== 'object') issues.push('parameters.type 不是 object');
  if (p.additionalProperties !== false) issues.push('additionalProperties 不是 false');
  for (const r of required) if (!props[r]) issues.push(`required 里的 ${r} 没有定义`);
  for (const [k, v] of Object.entries(props)) {
    if (!v.type && !v.enum) issues.push(`${k} 没有 type`);
    if (v.enum && v.type !== 'string' && !v.type) issues.push(`${k} enum 缺 type`);
  }
  if (typeof t.execute !== 'function') issues.push('没有 execute');
  if (typeof t.description !== 'string' || !t.description) issues.push('没有 description');
  if (issues.length) bad += 1;
  lines.push(`- ${t.name}: ${Object.keys(props).length} 个参数${issues.length ? `  ❌ ${issues.join('；')}` : '  OK'}`);
}

const build = tools.find((t) => t.name === 'vocab_build_docx');
if (!build) {
  lines.push('❌ 找不到 vocab_build_docx');
  bad += 1;
} else {
  const lang = build.parameters.properties.language;
  if (!lang) { lines.push('❌ vocab_build_docx 缺 language 参数'); bad += 1; }
  else {
    lines.push(`vocab_build_docx.language = ${JSON.stringify(lang)}`);
    const okEnum = lang.type === 'string' && Array.isArray(lang.enum)
      && lang.enum.join(',') === 'en,ja';
    if (!okEnum) { lines.push('❌ language 的 type/enum 不对'); bad += 1; }
    else lines.push('✅ language 参数：type=string，enum=[en,ja]');
  }
}

const collect = tools.find((t) => t.name === 'vocab_collect');
if (collect) {
  const lang = collect.parameters.properties.language;
  lines.push(`vocab_collect.language = ${lang ? '有' : '缺'}`);
}

lines.push(bad === 0 ? '契约检查：全部通过' : `契约检查：${bad} 处问题`);
console.log(lines.join('\n'));
process.exitCode = bad === 0 ? 0 : 1;
