# 修复清单（日文支持施工 · 按阶段登记）

登记日期：2026-11-10
基线：`git HEAD = 53f53aa`，工作树含 14 个已修改 + 13 个未跟踪文件（快照在
`..\vocab-digest-baseline-20261110-2145\`），英文基线 63/63 测试通过。

状态说明：`[ ]` 未开始 · `[~]` 进行中 · `[x]` 已完成并有测试 · `[!]` 阻塞

---

## T0 基线（已完成 2026-11-10）

- [x] 保存工作树快照（diff + 未跟踪文件副本 + HEAD/status）
- [x] 备份个人词表到 `..\vocab-digest-词表备份-20261110-2145\`
- [x] 记录英文基线：63 项测试全通过、87 文件零乱码、插件 9 工具契约通过
- [x] kuromoji 依赖验证：`kuromoji@0.1.2`（Apache-2.0）锁定，`package-lock.json` 生成
- [x] 写 ADR：`docs/adr/0001-ja-tokenizer-kuromoji.md`
- [x] 可重复探针：`tools/probe-ja-tokenizer.mjs` → 10/10 通过

---

## T1 语言参数与数据契约、依赖验证、资源初始化、英文兼容

- [x] `language` 契约：顶层 `language: 'en' | 'ja'`，缺省 `en`，`jp` 归一为 `ja`，
      非法值报 `INVALID_LANGUAGE`（不接受 `true` 等非字符串）
      → `src/languages/index.js`：`normalizeLanguage` / `isSupportedLanguage`
- [x] 同时更新 `config.default.json` 与 `src/config.js` 的 `BUILTIN_DEFAULTS`
- [x] 语言默认值优先于旧英文默认：ja 用 `minLen=1, minFreq=1`；先应用语言默认，
      再应用用户显式配置（不能让英文默认 3 无条件盖住日语）
      → 记 `userExplicitLex`（只认 `config.local.json` 与 `overrides`），
        随包 default 里的值不算「用户选择」
- [x] 日语的隐藏坑：`LANGUAGE_DEFAULTS.ja` **必须显式写出 `posFile: ''` 等空键**，
      省略会掉回 config.default.json 的英文路径；`loadLexicon` 的 `need()` 对空路径
      返回 null 但**不计入 missing**（空路径 = 本语言没有这个文件）
- [x] `prepareLanguageRuntime(config)`：按「语言+dataDir+版本」缓存，先 `ensureData` 再校验
      → `src/languages/runtime.js`，`RUNTIME_VERSION = 2`
- [x] `runDigestAsync(opts)`：先准备运行时再走同步编排；`runDigest` 同步契约不变
- [x] `prepareRuntime(opts)`（`src/run.js`）：建目录 + 校验 + 登记，缺文件报 `LEXICON_MISSING`
- [x] ja 不加载 ECDICT / 英文 pos / base / exceptions；不要求英文词表文件齐全
- [x] `ensureData(dataDir, { language })`：en 建 `data/` 骨架，ja 只建 `data/ja/`
      （`stopword.txt` / `known.txt` / `README.md`）
- [x] `src/run.js` 落盘 `language`、`schemaVersion: 2`；无该字段的旧结果按 `en` 读
- [x] CLI `--language` / `--lang`，`INVALID_LANGUAGE` 退出码 2
- [x] 英文回归：**83/83 测试全通过**（原 63 + 新增 20），词条统计不变
- [x] 插件契约 9 工具通过；`check-encoding` 94 文件零乱码

## T2 弹幕开关、多 P 真实路径与元数据、真实分片索引及并发限制

- [x] `src/fetch.js`：`if (subtitleLines || opts.withDanmaku)` → 仅 `withDanmaku === true`
      才把弹幕加入 digest 输入；默认只分析台词
      → 改为两个独立开关：`fetchDanmaku`（抓不抓，默认 true）/ `withDanmaku`（用不用，默认 false）
- [x] `src/fetch.js` 的 `tagify`：不再虚构 `subtitle.p2.srt`；`inputs` 必须是
      `existsSync` 为真的真实路径；P 号放到独立 `meta.json`
      → 新增 `inputs`（真实路径）+ `inputsRel`（相对路径）+ `labels`（带 .p2 的展示标签）三件套
- [x] 指定不存在的 page → 明确报错「这个视频没有第 N P（共 M P）」，不回退 P1；
      P 号 < 1 也报「分 P 号不合法」
- [x] `src/bili.js` 的 `danmakuIndex`：解析真实分片索引
      → **关键发现：DmSegConfig 是 DmView 的 field 4**（不是 field 1/2）。实测
        `page_size=360000, total=100`（毫秒时长 × 100 片）。解码器同时兼容
        「整个响应就是索引」（字段 1/2）与真实嵌套形态
- [x] 并发上限 → `mapLimit()` 滑动窗口 + `DEFAULT_DANMAKU_CONCURRENCY = 4`，
      可通过 `concurrency` 覆盖；不再 `Promise.all` 一次发完
- [x] 失败可见 → `danmaku()` 返回 `failed[{segment,error}]`；部分失败带 `warning`；
      全部失败报 `stage:'segments'`；索引失败报 `stage:'index'`。**不会静默变成 0 条**
- [x] 顺序保持 → 分片并发但结果按 `segment_index` 归位，再按时间排序
- [x] 字幕地址容错 → `subtitle_url` / `url` / `subtitle_url_v2` 都认；空地址不抛栈
- [x] 回归测试 → `test/t2-fetch.test.js` 27 项（见下）
- [x] **mock 验证**：开关组合 4 种、P2 路径全部存在、越界 P、非法 P、索引 3 种失败、
      部分/全部分片失败、并发峰值 ≤ 配置值
- [x] **真实联网验证**：BV1GJ411x7h7 抓 1405 条弹幕（1 片，0 失败，593ms）→
      digest → 65 词条，自检通过；BV1Z7xh6HEfD 索引解出 total=2、2 片全取到、
      该视频确实 0 条弹幕（不是失败）

### T2 过程中发现并修掉的真 bug

1. **索引字段号错**：一开始按 field 1/2 解，真实响应里索引在 **field 4** →
   报「page_size=0 total=0」。是真实联网验证抓出来的，mock 测不出来（mock 按我的假设造数据）。
2. **字幕字段名错**：`subtitleList` 只读 `s.subtitle_url`，而测试夹具/mock 用的是 `url`，
   说明字段假设本身脆弱 → 改成多个候选名容错 + 空地址保护。
3. **只有弹幕时错误信息丢失**：失败分支原先没带出 `danmaku` 信息，用户看不到真实原因。

## T4 词表计数、空 known 文件、导入掌握状态、回收站失败保护

> **状态：T4 的「存储层独立修复」已做完，但整体 T4 未完成。**
> 日文卡片、读音、导出要等 T3 接入后才验收，本阶段不能标记 T4 完成。

- [x] 核实 `touch` 的所有调用点，统一签名 `touch(id, count)`；
      `src/run.js:192` 原来传的是 `{count: n}` 对象 → 已改为数字。
      另加 `normalizeCount()`：任何脏值（对象/负数/小数/NaN/Infinity）都收敛成非负整数
- [x] 测试断言落盘的 `count` 必须是 `typeof === 'number'`（索引与 meta.json 都查）
- [x] `store.create` 的 `known.txt` 改用 `writeTextAtomic` 写真正空文本
      （原来用 `writeJsonAtomic` 把空字符串写成 JSON 字符串 `""`，3 字节）
- [x] `store.importFile` 不再自动把所有词写进 `known.txt`：默认「待学习」，
      仅显式 `markKnown: true` 才标记掌握；既有 known 记录原样保留
- [x] `store.remove` 回收站移动失败时**抛 `WORDLIST_TRASH_FAILED` 并保留原表**，
      已删掉 `rmSync` 永久删除的退路；索引改写放在 rename 成功之后，
      中途失败不会让索引与磁盘对不上；支持 `opts.trashDir` 便于测试与多盘场景
      - ⚠️ **已知限制：不是所有失败路径都保证原样保留。**
        `renameSync` 成功之后、`saveIndex()` 写入失败时，目录已经在 `.trash` 里、
        索引里却还留着那条记录 → 索引指向一个不存在的目录。
        这条路径**没有**事务回滚，因为回滚本身也可能失败（磁盘满/权限）。
        已登记为待办「删除操作的两阶段提交」，见下方「未完成事项」。
        目前 `saveIndex` 用 `.tmp + rename` 原子写，磁盘正常时失败概率很低，
        但只要写失败就会留下不一致 —— 不能宣称删除失败一定原样保留。
- [x] 旧数据兼容：`readKnownFile()` 把历史遗留的 `""` / `[]` / `null` / JSON 数组
      都读成正确结果；行分隔兼容 `\r\n` `\n` 与老 Mac 的单个 `\r`
- [x] 一次性迁移脚本 `tools/migrate-known-empty.mjs`：把内容等价于空的已知 `known.txt`
      改成零字节（**只动空文件，有词的完全不碰**）。已在本地用户词表上执行：
      「我的词汇」3 字节 `""` → 0 字节
- [ ] 备份包含 known 状态（现有 backup 只含 meta/cards）—— 不在本轮四项内，留待后续
- [x] 回归测试 → `test/wordlists.test.js` 新增 11 项（见下）

### T4 本轮测试清单（`test/wordlists.test.js`，23 项里新增 11 项）

| 用例 | 覆盖点 |
| --- | --- |
| count 归一 | 0/正数/字符串/对象/负数/小数/NaN/Infinity/null/undefined |
| touch 落盘 | 索引与 meta.json 都是 `typeof number`；传对象也变 0 而非 `[object Object]` |
| 空 known | `readFileSync === ''`，`!== '""'` |
| known 往返 | 写入/读出/清空回零字节 |
| 旧数据兼容 | `""`、JSON 数组、CRLF、单 `\r` 四种历史格式 |
| 导入默认不掌握 | `markKnown` 为 false 时 known 保持空 |
| 显式 markKnown | 只有 `markKnown: true` 才写入 |
| 历史掌握不受影响 | 先有的已掌握表在别处导入后保持原样 |
| 回收站失败 | 抛 `WORDLIST_TRASH_FAILED`；目录/known/cards/index/activeId 全部原封不动 |
| 回收站成功 | 目录真的进 `.trash`、原目录消失、activeId 正确回落 |
| 失败后重试 | 失败一次 → 换回默认回收站 → 仍能正常删除 |

---

## 未完成事项（明确登记，不随阶段推进而消失）

1. **删除操作的两阶段提交**（T4 遗留）
   `remove()` 里 `renameSync` 成功、`saveIndex()` 失败时，目录已在 `.trash`、
   索引仍含该条 → 索引指向不存在的目录。需要的做法是把索引改写记成
   「进行中→完成」的意图日志，启动时对账回滚；回滚本身也必须可重入。
   在那之前，**不能声称删除失败一定原样保留**。
2. **备份包含 known 状态**（T4 遗留）
   `backup()` 目前只写 `{schema,meta,cards,exportedAt}`，丢了 known.txt。
   搬家到别的电脑后「已掌握」会全部丢失。
3. **历史计数重算**（已提供工具，未接入流程）
   `tools/recount-cards.mjs` 能从 cards.json 实际卡片数重算 count 并同步 meta.json。
   当前本机数据经核验是**正确**的（2 / 11 / 81 与索引一致），没有脏数据。
   `normalizeCount()` 只是防未来，**不能用于恢复历史错误计数** ——
   恢复只能靠实际卡片数重算，这条已写进工具注释。

---

## 后续阶段（T1/T2/T4 完成后再细化）


- T3 日文词汇引擎（原形/读音/词性/offset/未知词标记/サ変合并/半角 NFKC）
- T5 所有入口贯通 language（CLI / Web / 插件 / cordis.patch.yml）
- ⚠️ T5 暴露的 T6 问题：日文运行的 Word 标题仍是「英语词汇整理 · ja」（标题前缀不该硬编码英文，见 `src/run.js` defaultTitle / `docx.titlePrefix`）
  - ⚠️ T5 暴露：日文产物里没有 `w:eastAsia` 字体声明（`ooxml.js` 的 `run()` 只在传 `opts.font` 时才写 `rFonts`），日文字形由 Word 自行回退，T6 要显式指定日文字体
- T6 UI、导出与重渲染（语言选择、假名读音、Word 日文字体与 `w:eastAsia`）
- T7 可选日文释义数据（用户词表优先；JMdict 需单独验收许可与语种）
- T8 发布验收（打包改为按脚本位置定位、语言包、空目录安装验证）

---

## T4 完成情况与遗留（2026-11-10 更新）

已完成（证据见 `docs/evidence-t4.txt`，由 `tools/evidence-t4.mjs` 生成）：

- [x] `src/meanings.js`：释义 provider 接口 + 本地 JSON / TSV 两种实现
- [x] 查询含 **词形 + 读音 + 词性**，同形异读（日本 ニホン / ニッポン）分开命中、不串项
- [x] 通配条目（不写读音/词性）只在没有更精确条目时兜底
- [x] 结果标明 **释义语言 + 来源**（revision / wordlist / provider / none）
- [x] 优先级：人工修订 > 当前词表 > provider；**空串不算有释义**，会继续往下走
- [x] 三种状态分开：`unconfigured`（文件不存在）/ `failed`（存在但解析不了）/ 未命中
- [x] 释义缺失仍可出词条与 Word；提示**按运行汇总一条**，不逐词刷屏
- [x] 卡片 → 备份恢复 → 导出导入 → 重渲染，保留 `entryKey` / 读音 / 假名 / 词性细节 / `unknown` / `lemmaSource` / 释义语言与来源
- [x] `backup()` 带上 known.txt（消除上文「未完成事项 2」）
- [x] `exact=false` 时条目 `offsetExact:false`，用法 `start/end=null`，Word 输出「定位提示」而不是区间

遗留（不算缺陷，但要知道）：

1. **导出文本不携带释义语言/来源**。导出的纯文本只有「词条 / 词性 / 释义 + #ja 元信息」，
   `meaningLanguage`、`meaningSource` 在文本往返后会丢（备份 JSON 往返不丢）。
   文本格式要保持可读可手改，这是一个**有意的取舍**，要保留就得加字段行。
2. 导入文本的词形会被统一小写（`looksEnglish` 那条老规则），日文汉字/假名不受影响，
   但 `Vtuber` → `vtuber` 这类混写词会变。
3. **本机 `data/wordlists/*/known.txt` 只有占位内容**，`store.known()` 能读，但 `run.js`
   主路径走 `lexiconPatch` 而不是 `known()`，两者目前没有交叉验证，迁移时要留意。

---

## T5 入口贯通（已完成 2026-11-10）

详细入口矩阵与证据见 `docs/evidence-t5.md`。

- [x] CLI `--language` / `--lang` 贯通 digest / init / transcribe；非法值退出码 2
- [x] Web `POST /api/run/digest` 透传 language（ja 走 `runDigestAsync`），非法值返回可读错误
- [x] Web `POST /api/run/fetch` 透传 language（字幕轨按语言优选）
- [x] 插件 `vocab_collect` 新增 `language` 参数，内部按语言选同步/异步管线；output schema 同步声明
- [x] `overridesOf(config)` 透传 `config.language`；`cordis.patch.yml` 增加 `language: 'en'` 段
- [x] **重渲染沿用原运行语言**：`renderRun` 用 `digest.json` 的 `language`，不采用调用方当前配置
- [x] 旧记录（无 `language` / 无 `schemaVersion`）按 `en` 读
- [x] **词表语言落盘**：`create()` 把 `language` 写进 `meta.json` 与 `索引.json`；
      `create('名字', {language})` 与 `create({name, language})` 两种写法都支持
- [x] 测试：`test/t5-entry.test.js` 10 项 + `test/t4-known-parity.test.js` 4 项

### 并入 T5 修复的 T4 兼容缺口（用户 m07764 点名四项）

- [x] **日文导入不再套用英文小写规则**：`Vtuber` / `iPhone` / `USBメモリ` 往返后词形与 `entryKey` 不变
- [x] **掌握状态三路交叉验证**：`known()` / `lexiconPatch().words` / 实际 digest 过滤一致；
      同形异读（日本 ニホン vs ニッポン）只过滤被标的那一个。
      ⚠️ 顺带修掉一个真缺口：**日文 `digestJa` 之前完全没有 `known` 过滤**，标记已掌握在日文路径下无效
- [x] **未配置 vs 路径错误分开**：用户显式配置的路径不存在 → `failed`（不掩盖拼写错误）；
      默认探测路径不存在 → `unconfigured`
- [x] **可读文本导出明确标为有损**：`exportText` 返回 `lossy: true` + `lossyFields`；
      新增 `exportJson()` 结构化无损导出（entryKey / 读音 / 假名 / 词性细节 / unknown /
      lemmaSource / 释义语言 / 释义来源 / 掌握状态全部保留）

### T4 遗留三条的处理结果

> T4 整体仍记「主体完成，仍有兼容缺口」—— 日文 UI / 词表界面 / Word 卡片的**展示层**
> 尚未按 T6 验收；上面四条兼容缺口已在本轮修完并有测试。

- [x] 遗留 1（导出丢释义语言/来源）→ 已加 `exportJson()` 无损导出，`exportText` 显式标 `lossy`
- [x] 遗留 2（导入小写）→ 日文表已保持原形
- [x] 遗留 3（known 未交叉验证）→ 已加 `test/t4-known-parity.test.js`

### 仍未做（属 T6 / 后续）

- 日文词条在 Web 界面 / Word 里的**展示层**（读音、假名、unknown 标记的视觉呈现）
- 日文词表的界面入口（下拉里选语言）
- 短语抽取（首版 ja 明确关闭）

---

---

## 不做 / 明确排除

- 不用正则或 `Intl.Segmenter` 冒充形态分析
- 不把中文翻译字幕当作日文原文
- 不编造读音、假名或 JLPT 等级；未知词标 `unknown: true`、`lemmaSource: 'surface'`
- 首版 ja 不启用短语抽取（英文 PMI / 空格 n-gram 不适用于日语）
- 不宣称「未知词约 5-10%」——该比例未验证，验收时按实际口径统计
