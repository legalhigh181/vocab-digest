/**
 * 日文形态分析（kuromoji）封装。
 *
 * 三条铁律（都由实测数据支撑，见 docs/adr/0001-ja-tokenizer-kuromoji.md）：
 *
 *   1. **`reading` 是「这个表面形」的读音，不是原形读音。**
 *      住ん(連用タ接続) 的 reading 是 スン，不是 スム。所以：
 *      - `surfaceReading`：表面形怎么读（可以标在这里，因为它是真的）
 *      - `reading`：**原形**的读音 —— 只能从「原形本身被分词」的 token 上取，
 *        取不到就留空，绝不拿活用读音冒充。
 *
 *   2. **未知词** = `basic_form === '*'`。这类词的读音是 null，
 *      不编造，标记 `unknown: true` + `lemmaSource: 'surface'`（回退到表面形）。
 *
 *   3. **半角片假名** kuromoji 完全不认，调用前必须 NFKC 归一（clean.js 已做）。
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

/** 词典目录：kuromoji 包内置（不需要额外下载） */
export function kuromojiDictPath() {
  const pkg = require.resolve('kuromoji/package.json');
  return join(dirname(pkg), 'dict');
}

/** 锁定版本，写进 digest.json 便于复现 */
export function kuromojiVersion() {
  try { return require('kuromoji/package.json').version; } catch { return null; }
}

/** 建 tokenizer（异步；同一进程内复用） */
let cached = null;
export function buildTokenizer(opts = {}) {
  if (cached && cached.dicPath === (opts.dicPath ?? kuromojiDictPath())) return Promise.resolve(cached.tokenizer);
  const dicPath = opts.dicPath ?? kuromojiDictPath();
  return new Promise((resolve, reject) => {
    let kuromoji;
    try { kuromoji = require('kuromoji'); } catch (e) {
      const err = new Error(`日文分词依赖缺失：kuromoji（${e.message}）。请先运行 npm install。`);
      err.code = 'JA_TOKENIZER_MISSING';
      throw err;
    }
    kuromoji.builder({ dicPath }).build((err, tokenizer) => {
      if (err) {
        const e = new Error(`日文词典加载失败：${err.message}（词典目录 ${dicPath}）`);
        e.code = 'JA_DICT_MISSING';
        e.dicPath = dicPath;
        reject(e);
        return;
      }
      cached = { dicPath, tokenizer };
      resolve(tokenizer);
    });
  });
}

/** 是否有可用的分词器（同步检查依赖是否装了，不加载词典） */
export function hasTokenizerDependency() {
  try { require.resolve('kuromoji'); return true; } catch { return false; }
}

export { here };
