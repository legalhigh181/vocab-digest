# 交接文档 —— vocab-digest（词汇库）给 Astra

> 2026-11-12 接续更新：UI 已改为蓝白学习手账，入口与布局以当前代码和 `docs/evidence-ui-notebook.md` 为准。最新候选包为 21,168,726 字节 / 1392 条目 / SHA-256 `2ce21fee7eb226d24e2309f7a6ca11a60cb6af3b52de8c685349b5de183945e3`，回归 286/286；以下 2026-11-11 快照及建议保留为历史。

> 写于 2026-11-11。目标是让接手的人（或 AI）在半小时内能改得动、不踩坑、知道自己改的东西有没有验收。
> 想知道「做了什么、证据在哪」看 `docs/验收总表.md`；想知道「某个 bug 怎么修的」看 `docs/evidence-t6.md` / `evidence-t7.md`。

---

## 0. 一句话

本地跑的**视频 → 词汇表 → Word**工具：给 B 站视频（或其他音视频）做转写/弹幕收集，抽词、标注读音与释义，导出可打印的 Word 词表。英文（ECDICT 词典）+ 日文（kuromoji 分词）双语。

- 位置：`C:\Users\18169\Documents\工作区 2\vocab-digest`
- 形态：**纯 Node（>=20）+ 自带 ffmpeg 能力**，没有 Python 运行时；依赖只有 `kuromoji@0.1.2`（含 17MB 词典）
- 三条入口：CLI（`bin/vocab-english.js`）、本地 Web 界面（`bin/vocab-app.js`，默认 127.0.0.1:7788）、DSH 插件（`src/index.js`，9 个 `vocab_*` 工具）
- 阶段：T0–T7 全部完成；**代码与打包已完成，未对外发布、未标记版本验收完成**

## 1. 现状快照（2026-11-11）

| 项 | 值 |
|---|---|
| 全量测试 | **286 项 / 286 通过 / 0 失败 / 0 跳过** |
| 编码体检 | `node tools/check-encoding.mjs` → **123 个文件通过** |
| 候选包 | `dist/词汇库-v1.0-windows.zip` → **20,335,377 字节 / SHA-256 `da2bd303fa280a6a20af044888debd37d2d7d47c51b6ed39a0e36ba4e92f8ef9` / 1383 条目**，解压 26.4MB |
| 包内依赖 | kuromoji 0.1.2 / async 2.6.4 / doublearray 0.0.2 / zlibjs 0.3.1 / lodash 4.18.1 |
| 界面资源 | app/public 合计约 2.55MB（美术原图 `*-sheet.png` 不进包，见 `tools/pack-release.mjs` 的 `EXCLUDE`） |

> **任何代码改动都会让上面的 SHA-256 作废**，必须重新打包并同步更新 `docs/验收总表.md`、`docs/evidence-t7.md` 里的哈希（见 §10）。

## 2. 十分钟上手

```powershell
cd 'C:\Users\18169\Documents\工作区 2\vocab-digest'

# 全量测试（必须带 --test-isolation=none，见 §6）
node --test --test-isolation=none test/*.test.js

# 编码体检（改过含中文的文件就跑）
node tools/check-encoding.mjs

# 起本地 Web 界面
node bin/vocab-app.js --cwd .        # http://127.0.0.1:7788

# CLI：英文 / 日文
node bin/vocab-english.js digest test/fixtures/lecture.srt --title 试跑
node bin/vocab-english.js digest samples/ja/xxx.srt --language ja

# 打包 + 干净目录自检
node tools/pack-release.mjs
node tools/check-release.mjs "%TEMP%\某个解压目录"
```

## 3. 目录与职责

```
src/
  cli.js cli-args.js          CLI 入口与参数解析
  run.js                      运行编排：runDigest / runDigestAsync / renderRun / runId 抢占
  pipeline.js                 抽词主流程（clean → tokenize → 过滤 → 词条组装 → 释义）
  extract.js phrases.js usages.js tokenize.js   英文抽词/短语/例句定位
  bili.js                     B 站 API：视频信息、弹幕、音频 URL、流式下载（.part + 镜像兜底）
  fetch.js                    取数编排：建目录 → 下音频 → 字幕轨/ASR → meta.json
  asr.js                      ffmpeg + whisper 子进程：超时/取消/暂存/原子提交/输出锁
  meanings.js                 释义 provider（revision > 词表 > 词典/JSON/TSV）
  classify.js clean.js config.js export.js index.js util.js verify.js
  languages/                  en/ja 契约（normalizeLanguage / DEFAULT_LANGUAGE）
  ja/                         entrykey.js（键格式与兼容）/ clean.js / tokenizer.js / extract.js
  app/server.js               本地 HTTP 服务 + 静态资源 + 后台任务表
  docx/{build,ooxml,write,zip}.js   手写 OOXML 生成 Word（无第三方库）
  wordlists/{store,import}.js 用户词表（索引.json + 每表一目录）
app/public/                   app.html / app.css / app.js（原生 JS，无框架、无构建）
bin/                          vocab-english.js（CLI）、vocab-app.js（Web）
data/                         词典与词表数据（见 §5）
test/                         node:test 测试，按阶段命名（t4-/t5-/t6-/ja-/entrykey-…）
tools/                        探针与打包脚本（大部分是证据用，不进发布包）
docs/                         验收与证据文档 + ADR
```

## 4. 数据流

```
入口 A（Web）: 页面 → /api/run/fetch/start（立刻拿 taskId）→ 后台 fetch → /api/run/digest → /api/view 渲染
入口 B（CLI）:  vocab-english digest <文件|目录> [--language en|ja] → runs/<runId>/{digest.json,vocab.docx}
入口 C（插件）: vocab_collect → vocab_translate → vocab_build_docx（可带 language 覆盖）
```

关键中间件（都在 `runs/<runId>/`）：`digest.json`（词条主数据）、`vocab.docx`、`decisions.json`（人工修订）、`review.txt`。

## 5. 数据契约（改之前必须看懂）

**digest.json 的词条**（数组键名是 `items`）：

```
language / entryKey / word / display / reading / readingHiragana / pos / posDetail
meaning / meaningLanguage / meaningSource / unknown / lemmaSource / forms
usages[{start,end,surface,surfaceOriginal,t,src,text}] / offsetExact
```

- **entryKey**：日文 `ja|词形|读音|词性`，`|` 转义为 `\|`，未知读音用 `?`；英文是 `word`。
  - 老格式是 NUL 分隔（`ja\0…`），**已改为 `|`**；兼容层在 `src/ja/entrykey.js`（`normalizeJaEntryKey` 在 known / decisions / 卡片 / 服务端读取处都调用过）。
  - 不要绕过 `normalizeJaEntryKey` 直接比较键，否则老数据（备份、T3 时期 run）会读不到。
- **offset**：JS UTF-16 半开区间，`text.slice(start,end) === surfaceOriginal`；`offsetExact:false` 时 `start/end` 为 `null`，UI/Word 只能给整句。
- **大小写**：英文词形统一小写；日文不折叠（同形异读靠 entryKey 区分）。
- **词表**：`data/wordlists/索引.json` + 每表一目录（`cards.json` / `known.txt` / `meta.json`），索引与 meta 都带 `language`；**一张表一种语言**。
- **释义三状态**：有释义 / 词典缺 / 未收录（`unknown:true`，读音留空，**不编造读音**）。

## 6. 铁律与踩坑（照着做能省几小时）

1. **测试必须** `node --test --test-isolation=none` 并显式列文件；沙箱里默认隔离模式会 EPERM。
2. **改含中文的 `.js/.css/.html` 只用 write/edit 工具**。PowerShell 的 `-replace` / `Set-Content` / `Add-Content` 会写成 GBK 乱码（踩过两次）。
3. **`node -e` 带引号/反斜杠会被 PowerShell 吞**，一律写成 `.mjs` 文件再 `node file.mjs`；`.mjs` 里用 `import`。
4. `package.json` 是 `"type": "module"`。
5. **不要用 python-docx 或 Word COM 验证 docx**（会挂死）。docx 正确性靠 `test/docx.test.js` + 解压 `word/document.xml` 检查。
6. `.ps1` 必须 UTF-8 **带 BOM**、注释只能用 `#`；`.vbs` 用 UTF-16LE+BOM；`.cmd` 纯 ASCII。
7. **zip 条目名必须正斜杠**。.NET 的 `ZipFile.CreateFromDirectory` 会写反斜杠 → macOS/Linux 解压成一堆怪文件。现用 `src/docx/zip.js` 的 `makeZip` 自写，并在 `pack-release.mjs` 里回读校验。
8. kuromoji 的 Node 入口是 `package.json.main`（`./src/kuromoji.js`）；`build/kuromoji.js` 是浏览器包，import 会报 `XMLHttpRequest is not defined`。builder 判断要兼容 CJS：`typeof kuro === 'function' ? kuro : kuro.builder`。
9. `readZip(buf)` 返回 **`Map<string, Buffer>`**；`startApp()` 返回 `{server,port,url,setFetchVideo}` 且 **url 带尾斜杠**（拼路径要 `replace(/\/$/,'')`，否则 `//api` 全 404）。
10. `runDigest/runDigestAsync` 的输入路径按 **process.cwd()** 解析，不认 `opts.cwd`——脚本里给绝对路径最稳。
11. `transcribe()` 返回体**没有 `ok` 字段**，失败是抛错；成功体含 `{input,out,model,language,gpu,bytes,elapsedMs,status}`。
12. **语言必须一路传到转写层**。曾经前端与插件都没传 `language`，whisper 用英语模式处理日语音频，产出 `[MUSIC PLAYING]` / `(singing in foreign language)`，再喂给日文分词 → 0 词条（用户报「根本没识别到」）。修在 `app/public/app.js` 的 `doFetch` payload、`src/index.js` 的 `vocab_collect`，并有 `test/t6-tasks.test.js` 里一条命名测试锁住。
13. `meta.json` 在下载音频**之前**就写，取消后会被刷新是设计行为；不要用「一字节不变」断言它。
14. 取数的输出目录是 `samples/<bvid>.p<page>/`；**已有 `audio.p1.srt` 且没开 overwrite 会报 `OUTPUT_CONFLICT`**（故意的，防覆盖旧产物）。

## 7. 验收状态

| 项 | 状态 |
|---|---|
| CLI 端到端（含非法语言拒绝） | ✅ 真跑过 |
| `runFfmpeg` 真 spawn（超时/取消/清理/stderr 上限） | ✅ 32/32 |
| whisper 真转写 | ✅ 中文 20s→3.2s/7 条；日语两段音频 7/7 断言通过 |
| 真实浏览器（Edge headless + CDP） | ✅ 14/14，截图 `docs/evidence-browser-ja.png` |
| 真实 B 站完整流程 / 执行中取消 | ✅ 31 项（A 10 + B 9 + C 8 + D 4） |
| 中文+空格路径干净目录 | ✅ 解压后 34 项自检全绿 |

**仍不确定的**：

- **B 站日文字幕轨到底有没有** —— 匿名调接口全是 0 轨，而标题写着「CC字幕/中日双语」的视频也为 0，基本可判定是**匿名态假阴性**；要验必须登录态，而这台机器的 Edge 用应用绑定加密（`v20`/`APPB`），复制 profile 给无头实例解不开，真 profile 又不许开远程调试。**换机器或让用户手动导出 cookie 才能验**。
- **真实 Word 打开效果**没验（按规矩不用 Word COM），只验了 XML 结构。
- **安装脚本在干净机器上的端到端**没验（`安装.cmd` → `工具/install.vbs`）。
- 用户（LIZ）没有独立复核过代码与 ZIP。

## 8. 已知限制（先别当 bug 修）

1. **日语 ASR 质量有限**：`ggml-small.bin` 对短词/长音/促音/撥音区分基本丢失，偶发整句幻觉；实测发音练习 14 词对 8–9 个。界面与文档已明确提示（`#jaAsrNote`）。想提升只能换更大模型（`ggml-medium`/`large-v3`，体积 1.5–3GB），属于产品决策。
2. **分词噪音**：`ー`（长音符号）会被当成词且未收录；whisper 的 `(音楽)` 标记会把「音楽」刷成高频词（那条 24 分钟视频里 ×109）。
3. **日文释义覆盖极低**：`data/ja/meanings.json` 只有示例条目，实测 772 词条里只有 8 条有释义。这是数据问题不是代码问题。
4. 日文字体 `Meiryo` 在非日文 Windows 上可能缺失，回退字体未做；`w:eastAsia` 只声明了 Meiryo。
5. B 站 CDN 直连在本机被 TLS 重置，靠 `MIRROR_HOSTS`（cos/ali）兜底；无代理对照**只做过一次**，不能断言「一定是网络环境」。
6. 打包体积 20MB 里 kuromoji 词典占 17MB，进 zip 是刻意选择（解压即离线分词）。

## 9. 优化建议（按性价比排序）

### P0 —— 用户明确点名的：UI

现在 `app/public` 是三栏原生布局（左：视频地址/词表/历史；中：词条列表；右：词表内容/详情），无框架无构建，26KB CSS + 36KB JS。具体问题：

1. **词条列表全量渲染**。`renderItems()` 把 `viewOf` 返回的所有 items 一次性塞进 DOM（772 条 = 772 个卡片节点），且 `/api/view` 一次吐全量词条（含 usages）。建议：服务端分页（`?offset=&limit=`）+ 前端虚拟滚动或「加载更多」，首屏 50 条；搜索结果高亮关键词。
2. **右栏信息太挤**。词表内容（gliding/manual 两列）与「用法/详情」上下堆叠，长释义会把布局撑破；建议详情改成抽屉/浮层，右栏只留词表与导出。
3. **缺批量操作**。目前只能一条条加词表、一条条看详情；建议：词条卡复选框 + 全选当前筛选结果 + 「批量加入词表 / 批量标记已掌握 / 批量导出」。
4. **缺进度反馈**。抓取/转写只有一行日志文字；建议进度条（B 站阶段：取信息 → 下音频 → 转写 → 分析），转写阶段能显示已处理秒数（whisper 不支持进度回调，可用 ffmpeg `-progress` 或按音频时长 + 已耗时估算）。
5. **无空态与引导**。第一次打开不知道要先粘地址；建议空态卡片（三步图解：粘链接 → 抓字幕 → 导出）。
6. **响应式/窄屏**。三栏在 <1280px 挤压严重；建议断点折叠成单栏 + 顶部 tab。
7. **无深色模式**。CSS 变量已经集中在 `:root`（`--pink-soft`/`--warn` 等），加 `[data-theme=dark]` 一套变量即可，成本低。
8. **词条卡信息层级**：目前「词形 + 词性 + 次数 + 读音 + 例句」全平铺；建议词形大字号、读音次之、例句弱化并可折叠，长例句单行截断 + hover 展开。
9. **可访问性**：按钮多为 div/span + onclick，建议至少 `button` 元素 + `aria-label`；键盘 Tab 可达。
10. **【高价值】点例句跳回视频**。`usages[].t` 有时间戳，可以把「▶ 0:20」做成 B 站带 `?t=20` 的链接（已有 formatTime 逻辑），点一下回到原片听那句——这是这类工具最刚需的体验。

美术资源里已有整套角色表情（`emo-*.png`、`el-*.png`、`maid-sheet.png` 里切），UI 改版可以直接复用，不用另找设计。

### P1 —— 功能与质量

11. **日文释义来源**：接 JMdict（许可需确认）或开放词典的日中词表，先把 772 条里 764 条空释义补上；这是日文模式最影响可用性的一环。
12. **日语 ASR 升级路径**：把模型选择做成配置（`ggml-small`/`medium`/`large-v3`），首页显示「当前模型 + 推荐」，用户在设置里切；顺带做首次运行下载引导（现在 `下载词典.cmd` 只解决英文词典）。
13. **硬字幕 OCR（v2）**：ffmpeg 抽帧 → 裁字幕带 → PaddleOCR/RapidOCR → 去重 → 时间轴。成本高（PDF 见聊天记录里的评估），建议先做最小验证：固定底部 20% 区域、只支持白字黑边，人工抽 3 个视频量准确率。
14. **B 站字幕轨**：拿到登录态 cookie 后，把「有轨优先用轨、没轨再 ASR」写进 `fetch.js`（现在只有 ASR 分支），能大幅提升日语视频质量。
15. **弹幕作为补充语料**：已有弹幕收集，但只当热度参考；可以让用户选择「弹幕也算语料」（口语词多，适合 N1 以下）。
16. **短语抽取对日文**：英文有 PMI n-gram，日文首版故意关掉（空格 n-gram 不适用）。可做「連語/惯用句」表驱动（kuromoji 词性 + 固定搭配表）。

### P2 —— 工程与发布

17. **性能**：`/api/view` 全量返回；772 条 digest 的 JSON 可能几 MB。加分页 + `ETag`。
18. **测试补强**：前端目前靠 `tools/probe-browser.mjs`（DOM 垫片）+ `tools/probe-browser-real.mjs`（CDP），没有单测；建议把纯函数（`readingLine`/`langBadge`/`formatTime`/搜索过滤）抽到 `app/public/lib.js` 做单测。
19. **安装体验**：`安装.cmd` 在新机器上没跑过；建议在一台干净 Windows 上验一遍（含无 Node 时的提示）。
20. **发布流程**：`tools/pack-release.mjs` + `check-release.mjs` 已经够用；可以把两者串成一个 `npm run release`，并在 CI 里跑测试（现在全靠本地）。

## 10. 改完必做的四件事

1. `node --test --test-isolation=none test/*.test.js` —— 不许低于 286 项通过。
2. `node tools/check-encoding.mjs` —— 必须通过（中文文件被 PowerShell 写坏会在这里暴露）。
3. 如果动了 `src/`、`app/`、`bin/`、`data/` 或包内任何文件：`node tools/pack-release.mjs` 重新打包，记下新的**字节数 + SHA-256**，解压到含中文和空格的路径跑 `node tools/check-release.mjs "<目录>"`。
4. 把新哈希同步到 `docs/验收总表.md`、`docs/evidence-t7.md`；在 `docs/验收总表.md` 补一节「追加修复」写清改了什么、为什么、证据。

## 11. 禁区

- **不要提交/打包**：`runs/`、`samples/`、`models/`（whisper 模型 465MB）、`versions/`、`data/wordlists/`（用户个人词表）、`data/ecdict.csv`（66MB）、`*.m4s/*.part/*.lock`、`*-sheet.png`。
- **不要动** `data/known/known.txt`、`data/ja/known.txt`（个人学习进度）、`config.local.json`（个人路径配置）。
- **不要改** 已有 `docs/evidence-*.md` 的历史结论（可以追加，不能改写；之前有过一次误覆盖证据文件的事故）。
- 备份目录（`vocab-digest-snapshot-*`、`vocab-digest-词表备份-*`）只读参考。

## 12. 参考索引

| 想知道 | 看 |
|---|---|
| 总体验收状态、包指标、未验证项 | `docs/验收总表.md` |
| 日文支持的 8 个阶段做了什么 | `docs/evidence-t6.md`（有逐条证据与六个真 bug） |
| 打包设计、干净目录自检、zip 坑 | `docs/evidence-t7.md` |
| entryKey 从 NUL 分隔改成竖线分隔的来龙去脉 | `docs/evidence-entrykey.md` |
| 为什么选 kuromoji | `docs/adr/0001-ja-tokenizer-kuromoji.md` |
| 还欠什么 | `docs/fix-list.md` |
| 用户使用说明 / 更新日志 | `使用说明.md` / `发布说明.md` / `README.md` |

有任何与本文冲突的地方，以 `docs/验收总表.md` 和实际测试结果为准——本文写于 2026-11-11，之后的改动不在其中。
