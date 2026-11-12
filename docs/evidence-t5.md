# T5 入口贯通 · 入口矩阵与实际调用证据

> 目的：证明 `language` 这条参数从**每一个入口**都能一路传到底，并且非法值/旧数据/跨语言情况都有确定行为。
> 本文件只记录**实际跑过**的证据，未验证的一律不写。

## 一、入口矩阵

| 入口 | 传参方式 | 底层调用 | 实测结果 |
|---|---|---|---|
| 命令行 `digest` | `--language ja` / `--lang ja` | `runDigestAsync`（ja）/ `runDigest`（en） | `--language ja` 写出 `digest.json` 的 `language: "ja"`、`schemaVersion: 2`；`--language xx` 退出码 **2**、提示「不支持的语言：xx（只接受 en / ja）」 |
| 命令行 `init` | `--language ja` | `prepareConfig` | 初始化 `data/ja/` 三个模板文件 |
| 命令行 `transcribe` | `--language ja` | `transcribe()` 的 whisper `language` 参数 | 参数透传到 ffmpeg 滤镜字符串 |
| Web `POST /api/run/digest` | `body.language` | ja→`runDigestAsync`，en→`runDigest` | 返回体带 `language`；非法值返回 `{ok:false,message:"不支持的语言：…"}` |
| Web `POST /api/run/fetch` | `body.language` | `fetchVideo({language})` | 字幕轨按语言优先挑选 |
| Web 重渲染 `POST /api/run/build` | 无（读运行自己的语言） | `renderRun` → `prepareConfig({language: dig.language})` | 即使调用方传 `configOverrides:{language:'en'}`，也不会把日语运行当英文重出 |
| 插件 `vocab_collect` | `args.language` → `overridesOf(config).language` | 同上 | 参数 schema 与 output schema 都声明了 `language` |
| 插件 `vocab_fetch` | `args.language` | `fetchVideo` | 透传 |
| 插件配置 `cordis.patch.yml` | `config.language: 'en'` | `overridesOf` | 默认 en；切 ja 时不要覆盖 `minLen`（日语默认 1） |

## 二、语言归一化

| 输入 | 归一结果 | 说明 |
|---|---|---|
| `undefined` / `null` / `''` | `en` | 缺省 |
| `en` / `EN` / `' en '` | `en` | trim + 小写 |
| `ja` / `JA` | `ja` | |
| `jp` | `ja` | 唯一别名 |
| `xx` / `zh` / `jpn` / `EN_US` / `123` | **抛 `INVALID_LANGUAGE`** | 不猜、不子串匹配；CLI 退出码 2 |

## 三、旧数据兼容

| 场景 | 行为 | 证据 |
|---|---|---|
| `digest.json` 没有 `language` 字段 | 按 `en` 读 | `test/t5-entry.test.js`「旧记录（没有 language 字段）按英文读」→ `renderRun` 自检通过 |
| `digest.json` 没有 `schemaVersion` | 同上，不报错 | 同上 |
| 词表 `meta.json` / 索引没有 `language` | `exportJson` 回落 `cards[0].language` 再回落 `en` | `store.exportJson` |
| 词表传入非法语言 | 回落到 `en`，不让整张表打不开 | `normalizeLanguageOr` |

## 四、跨语言词表

| 检查 | 行为 |
|---|---|
| 词表语言写入索引 | `create()` 把 `language` 同时写进 `meta.json` 与 `索引.json`（`test/t5-entry.test.js`） |
| 往英文表塞日文卡片 | 允许，但**词表语言不会被卡片的语言改掉** |
| `create('名字', {language})` 老写法 | 兼容（第一版签名只收一个参数，第二个被丢弃 —— 已修） |

## 五、重渲染使用原运行语言

`renderRun` 读 `digest.json` 的 `language`（缺省 en）后传给 `prepareConfig`，**不采用调用方当前的配置**。

- 测试：「重渲染沿用运行自己的语言，不被当前配置覆盖」——传入 `configOverrides:{language:'en'}` 去渲染一个 `language:'ja'` 的运行，自检仍通过。
- 实测：`renderRun({runDir:'runs/t4-ja-final'})` → `ok: true`，分章为 名词14 / 动词14 / 形容词1 / 副词1 / 专有名词2 / 其他3。

## 六、插件 schema 与实现一致

`node test/harness.mjs` → **9 个工具，输出字段全部在 schema 内**。

`vocab_collect` 的两处一致性有专门断言（`test/t5-entry.test.js`）：

1. `output.schema.properties.language` 存在，且 `required` 含 `language`；
2. 实现里 `return { …, language: meta.language ?? 'en' }` 与 schema 对应；
3. `parameters.properties.language` 存在。

`overridesOf(config)` 里有 `if (config.language) o.language = String(config.language)`，并有断言。

## 七、回归结果（2026-11-10）

```
node --test --test-isolation=none test\{parsers,text,engine,docx,run,tags,wordlists,languages,t2-fetch,ja,ja-offset,ja-offset-hand,t4-meanings,t4-offset-degrade,t4-known-parity,t5-entry}.test.js
→ 213 tests / 213 pass / 0 fail

node tools/check-encoding.mjs      → 112 个文件未发现乱码
node test/harness.mjs              → 9 个工具，输出字段全部在 schema 内
node bin/vocab-english.js digest test\fixtures --run-id t5-en          → 96 词条，自检通过
node bin/vocab-english.js digest samples\ja\demo.srt --language ja --run-id t5-ja → 35 词条，自检通过
```

## 八、这轮并入修复的 T4 兼容缺口

| 缺口 | 修法 | 测试 |
|---|---|---|
| 日文导入套用英文小写规则，`Vtuber` 往返后变 `vtuber` | `makeCard` 对日语表保留原形（`meta.japanese`）；`meta.language==='ja'` 同样保留 | `test/t4-known-parity.test.js` |
| `known()` / `lexiconPatch` / 实际 digest 三条路径不一致 | 日文 `digestJaSync` 新增 `known` 过滤（entryKey 优先、裸词形兜底）；`runDigest` 日文分支传 known.txt 的 entryKey | 同上，4 项 |
| 未配置与路径错误混在一起 | `createFileProvider` 区分 `explicit`：显式路径不存在 → `failed`，默认探测不存在 → `unconfigured` | `test/t4-meanings.test.js`「状态三」 |
| 可读导出被当成无损 | `exportText` 返回 `lossy:true` + `lossyFields`；新增 `exportJson` 结构化无损导出（含 entryKey/读音/释义来源/掌握状态） | `test/t4-known-parity.test.js` |
