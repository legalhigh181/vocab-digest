# entryKey 格式核实与兼容取证

**结论：`ja\0…` → `ja|…` 是真实的格式变更，不是展示转义。**
变更本身是有意的（见下「为什么换」），但**老数据兼容当时没做**，本轮补上了，并做了迁移工具与回到旧备份的验证。

---

## 1 · 为什么能确定是格式变更

`src/ja/entrykey.js` 的头注释保留了当年的判断：

> 最初用的是 NUL 分隔（`ja\0词形\0…`），在内存里很干净，但**一旦落到文本就出问题**：
> - 导出词表时 NUL 是不可见字符，用户复制/编辑极易无声破坏
> - 再导入时 `\S*` 正则在 NUL 处截断，键直接丢掉
> - 有些编辑器/剪贴板会静默剥离 NUL
>
> 换成 `|` 后可打印、可复制、可人工核对。

改动前的解析器对老键直接返回 `null`：

```
parseJaEntryKey('ja\u0000日本\u0000ニホン\u0000prop.')  →  null
```

现在引擎输出（真跑 kuromoji 得到，不是手写）：

| 场景 | 输出 |
|---|---|
| 普通词 | `ja|日本|ニホン|prop.` |
| 未知词（读音留空） | `ja|Vtuber|?|prop.` |
| 词形本身含竖线 | `ja|A\|B|エービー|n.` |

## 2 · 盘上到底有多少老键（`tools/probe-entrykey-format.mjs`）

扫 `data/`、`runs/`、4 个备份目录里的 json/txt：

```
ja|  280 处     ja\0  210 处     命中文件 7 个
```

| 文件 | 老键 | 说明 |
|---|---|---|
| `runs/ja-t3b/digest.json` | 70 | T3 时期的历史产物 |
| `runs/ja-t3c/digest.json` | 70 | 同上 |
| `runs/ja-t3d/digest.json` | 70 | 同上 |
| `runs/t4-ja-final/digest.json` | 0（70 处新格式） | T4 之后 |
| `runs/t5-cli-ja|t5-ja|t6-cli-ja/digest.json` | 0（各 70 处新格式） | T5/T6 之后 |

**关键：`data/wordlists/`（个人词表）、`known.txt`、`decisions.json` 里 0 处老键。**
所以本机上「已掌握的词」和「人工改过的释义」**没有实际受损**——但这是运气，不是设计：
谁在 T3 期间建过表，他的 known 就是 NUL 键，升级后会被当成不认识的键。

## 3 · 兼容层做了什么

新增 `src/ja/entrykey.js`（独立模块：store/import/server 要用，但不该把分词器拖进来）：

- `LEGACY_JA_KEY_PREFIX = 'ja\u0000'`
- `jaEntryKey(word, pos, reading, unknown)` —— 现在的唯一构造器
- `normalizeJaEntryKey(key)` —— 老 NUL 键 → 新 `|` 键；**幂等**；非 `ja` 键原样返回；段数不对也原样返回（不造假键）
- `parseJaEntryKey(key)` —— 先归一，再解析

归一不是只在读的地方做一次，而是**每个会落盘或比较的入口都做**：

| 入口 | 位置 | 做法 |
|---|---|---|
| 掌握词判定 | `src/ja/index.js` `isKnown` | `knownSet` 构造时逐项归一，查表前再归一 |
| 运行时的 known | `src/run.js` | `new Set(store.known(...).map(normalizeJaEntryKey))` |
| 人工释义 decisions | `src/run.js` `readDecisions` / `applyDecisions` | 整表归一后，按 `[归一键, 原键, 词形]` 三级查 |
| 抽词管线 | `src/pipeline.js` | 同上三级查（decisions 与词表释义都用） |
| 卡片落盘 | `src/wordlists/store.js` `writeCards` / `cardsFromDigest` | 落盘前逐卡归一 + 重算 `cardsHash` |
| 掌握状态落盘 | `store.writeKnown` | 逐行归一后再写 |
| 同形异读释义表 | `store.meaningsByEntryKey` | 键入表前归一 |
| 文本导入 | `src/wordlists/import.js` | `#ja` 行解析后归一 |
| Web 视图 / 人工修订 | `src/app/server.js` `viewOf`、`POST /api/decisions` | 归一后展示与落盘 |

### 顺带修掉的真 bug（导入的转义）

`cardsToText` 会把每个 `|` 与 `\` **再转义一层**，所以

```
卡片键  ja|A\|B|エービー|n.
文本行  #ja ja\|A\\\|B\|エービー\|n.
```

老代码读回时用链式 `.replace(/\\\\/g,'\0BS\0').replace(/\\\|/g,'|')`，
第二个 replace 会把本该保留的 `\|` 一起压成 `|`——**转义信息丢失，词形里的竖线还原不回来**。
已改成单遍 `unescapeKeyText()`（只扫一遍，遇 `\\`→`\`、遇 `\|`→`|`，其余原样）。
`test/entrykey-compat.test.js` 里有「导出→导入一圈保住转义」这一项盯着它。

## 4 · 迁移工具（`tools/migrate-entrykey.mjs`）

- **默认只报告，不写文件**；`--apply` 才动，`--json` 给机器读。
- 处理 `decisions.json` / `known.txt` / `cards.json`；写前备份 `<file>.bak-entrykey`；cards 用 `cardsHash` 重算。
- **`digest.json` 故意不动**：它是历史记录，读取时已归一，改它等于篡改历史。
- 在本机真实数据上 dry-run：

```
没有需要迁移的老格式 entryKey
```

（和上面「词表/known/decisions 里 0 处老键」一致。）

## 5 · 验证（`test/entrykey-compat.test.js`，11/11）

| 项 | 断言 |
|---|---|
| 归一与幂等 | 老键归一成新键，重复归一结果不变 |
| 英文键不受影响 | `en`/普通字符串原样返回 |
| 坏键不造假 | 段数不对的 `ja|…` 原样返回，不硬拼出读音 |
| 含 `|` 的键 | 构造转义、解析还原、归一后仍能解析 |
| known 写回升级 | 老键写进 known，读回是新键 |
| 老 known 真过滤 | 老 `ja\0日本\0ニッポン\0prop.` 能滤掉 ニッポン，**且不误伤 ニホン**（真 kuromoji） |
| decisions 老键 | 直接把老键塞进 decisions 也能命中 |
| 同形异读 | ニホン / ニッポン 各自命中，不串项 |
| 卡片落盘 | 老卡片写完变新键，释义表用新键可查 |
| 备份恢复 | 老备份 `restoreBackup` 后，卡片与 known 都升级成新键 |
| 导出→导入 | 一圈下来 `\|` 转义不丢 |

## 6 · 还剩什么

- 本机没有真处于「T3 时期建表」的用户数据，兼容性靠**构造老备份**验证；
  如果用户手上有更早的备份，建议先跑 `node tools/migrate-entrykey.mjs` 看报告再恢复。
- `runs/ja-t3b|t3c|t3d/digest.json` 仍是老格式（历史产物，读取时归一）。
  这些是取证目录，不进发布包。
