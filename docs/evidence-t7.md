# T7 · 打包与干净目录验证

> **2026-11-12 追加 UI 候选包**：`21,168,726 字节 / 1392 条目 / SHA-256 2ce21fee7eb226d24e2309f7a6ca11a60cb6af3b52de8c685349b5de183945e3`。已重新解压至中文+空格路径做干净目录自检，全绿；最终回归 286/286。详见 [UI 验收](evidence-ui-notebook.md)。下面原 2026-11-11 的结果保留为历史，其「当前包」措辞指当时状态。

日期：2026-11-11
状态：**打包与干净目录验证完成；T6 六项真实环境验收已全部跑过（其中日语识别质量为「部分正确」，如实记录）。仍不对外发布。**

> 2026-11-11 四次打包（当前候选包）：把「日语 ASR 质量有限」写进界面与说明后源码再变，按规则重打。
> 历史包全部作废：
> `20,330,559 / dc97d9a5…`（1382 条目）
> → `20,333,214 / 88fe0912…`（含 entryKey 兼容）
> → `20,333,442 / e757201d…`（含 CDN 多镜像兜底）
> → 当前 **`20,335,377 字节 / da2bd303fa280a6a20af044888debd37d2d7d47c51b6ed39a0e36ba4e92f8ef9`（1383 条目）**。
> 当前包已重新解压到中文+空格路径做干净目录自检，全绿。下文指标均指当前包。

---

## 0. 一句话结论

发布包改成「白名单 + 从锁定依赖装闭包 + kuromoji 词典随包」，打出 **19.39 MB** 的 zip；
解压到一个**含中文和空格的路径**后，不碰开发机、不装依赖、不联网，英文 digest、日文 digest（含读音）、
Word（Meiryo + 「日语词汇整理」+ 读音行）、插件入口、本地服务全部跑通。

---

## 1. 交付物

| 文件 | 作用 |
|---|---|
| `tools/pack-release.mjs` | 白名单收集 → 按 lock 装生产依赖闭包 → 生成 `THIRD-PARTY-NOTICES.md` → 打 zip → 打印大小 / SHA-256 / 文件数 |
| `tools/check-release.mjs` | 对着**解压出来的那份**跑 11 组 32 项断言（结构 + 不夹带 + 依赖 + 离线分词 + 英文/日文 digest + Word + 插件 + 本地服务） |
| `AGENTS.md` 第七节 | 打包规则、禁令清单、为什么这么写 |
| `README.md` / `发布说明.md` | 补日语一章；改掉「零第三方依赖」这句已经不成立的话 |

删除了被取代的 `tools/pack-release.py`、`tools/test-release.py`（它们不带 `node_modules`，要求用户自己 `npm install`，与本次要求相悖）。

---

## 2. 打包设计

**白名单，不是「全复制再删」**——以后新增的临时文件不会自己混进去。

- 整目录：`bin/`、`src/`、`app/`
- 根文件 13 个（含 `安装.cmd`、`客户端.vbs`、`cordis.patch.yml`）
- `tools/` 只带三个运行期脚本：`install.vbs`、`install-shortcuts.vbs`、`download-dict.vbs`（`.ps1` 一律不进包）
- `data/` 只带规则与模板 9 个；`known.txt` 写**空模板**覆盖个人进度
- `test/fixtures/` 三个小样本（让「解压后先跑一次看看」有东西可跑）
- `node_modules`：从 `package.json` 的 `dependencies` 走闭包，**逐个比对 `package-lock.json` 的版本，不一致直接报错**
  - 结果：`kuromoji@0.1.2`、`async@2.6.4`、`doublearray@0.0.2`、`zlibjs@0.3.1`、`lodash@4.18.1`
  - 整包复制（含 `LICENSE` / `NOTICE` / 词典），只剔除上游的 `test/`、`demo/`、`example/`（约 22MB，运行时用不到）
  - **保留 `kuromoji/dict/`（12 个文件，16.97MB）**——这是「解压即离线分词」的本钱
- 另外剔掉 `app/public/img/*-sheet.png`（5 张设定原图，约 15MB；线上用的是抠好的小图）

zip **自己写**（复用 `src/docx/zip.js` 的 `makeZip`），不用 .NET 的 `ZipFile.CreateFromDirectory`：
后者在 Windows 上把条目名写成 `node_modules\kuromoji\...`（反斜杠），违反 zip 规范——Windows 资源管理器勉强认，
macOS / Linux 解出来会是一堆名叫 `node_modules\kuromoji\...` 的单文件。写完立刻读回来验「全部条目正斜杠、中文名可解」。

---

## 3. 包指标（最终）

| 项 | 值 |
|---|---|
| 包路径 | `dist/词汇库-v1.0-windows.zip` |
| 大小 | **20,335,377 字节 = 19.39 MB** |
| SHA-256 | `da2bd303fa280a6a20af044888debd37d2d7d47c51b6ed39a0e36ba4e92f8ef9` |
| 文件数 | 1383 |
| 解压后 | 26.40 MB |
| 其中依赖 | 23.23 MB（kuromoji 17.26 + zlibjs 3.56 + lodash 1.35 + async 0.52 + doublearray 0.44） |
| 其中界面 | 2.55 MB（剔除设定原图前是 16.75 MB） |

对照：改版前的旧包 `dist/词汇库-v1.0-windows.zip` 是 2,604,021 字节，但**不含 `node_modules`**，日文分词在用户机器上根本跑不起来。

---

## 4. 干净目录验证（全新解压，路径含中文 + 空格）

解压到：`%TEMP%\词汇库 干净测试\ja 识别提示\`（对最终那个 SHA 的 zip 重新解压跑的，不是复用旧副本；路径含中文 + 空格）

### 4.1 结构与合规（11 组 34 项，全部 ✔）

| 组 | 断言 |
|---|---|
| 包内结构 | 21 个关键文件齐全；`kuromoji/dict/` 12 个文件 16.97 MB |
| 不夹带个人数据 | 1383 个文件里没有 `runs/`、`versions/`、`models/`、`samples/`、`data/wordlists/`、`data/ecdict.csv`、CSV、`ggml-*.bin`、`.part`、`.bak`、Cookie、`.git/`、`*-sheet.png`、`.asr-stage/`、`.lock`；文件名全部正斜杠分隔 |
| 个人进度 | `data/known/known.txt`、`data/ja/known.txt` 都只有注释，0 个词 |
| 无开发机路径 | 扫 54 个源文件，没有 `C:\Users\18169` / `工作区 2` |
| 依赖与 lock | 生产依赖只有 `kuromoji`；5 个包与 lock 完全一致；许可清单覆盖全部依赖；每个包内都带许可证原文 |
| 离线分词 | 从包内 `dict/` 建 tokenizer：`日本語 / を / 勉強 / し / て / い / ます`，读音 `ニホンゴ / ヲ / ベンキョウ / シ / テ` |
| 英文 digest | `language = en`，19 个词条（没有 `ecdict.csv` 也能跑，只是没有中文释义） |
| 日文 digest | `language = ja`，6 个词条；`entryKey` 全部 `ja\|` 开头；6/6 带片假名读音（`勉強する → ベンキョウスル`）；平假名也写了（`べんきょうする`） |
| Word | 6 KB docx；标题「日语词汇整理」；`w:eastAsia="Meiryo"` 出现 131 次；词条行带「读音：」；无英文前缀残留；`styles.xml` 里有 `w:eastAsia="ja-JP"` |
| 插件入口 | 注册 9 个工具；`vocab_build_docx.language` = `string enum[en,ja]`；`vocab_collect` 有 `language` |
| 本地服务 | `startApp` 起在随机端口；`/api/state` 正常；`/api/view?runId=check-ja` 回 6 个词条、6 个带读音、**0 个带 phonetic/dictMeaning/cambridge**（日文不查英文字典）；首页有语言入口 |

### 4.2 CLI 实测（在同一个中文空格目录里，exit 全为 0）

```
node bin\vocab-english.js digest test/fixtures/lecture.srt --run-id cli-en
  收录 19 个词条，过滤 0 个 · 自检 通过 · exit=0
node bin\vocab-english.js digest samples\check\ja.srt --language ja --run-id cli-ja
  文档 runs\cli-ja\vocab.docx · 自检 通过 · exit=0
  info: 4/6 个词条没有释义（词表与释义文件里都没查到）  ← 预期：data\ja\meanings.json 只有 11 条示例
node bin\vocab-english.js status
  词表目录：…\词汇库 干净测试\第三次 复核 解压\data（齐全）
  历史运行：4 次，四条都「自检通过」
```

> `status` 里的「语音转写：不可用（找不到 ffmpeg（EPERM））」是**本沙箱**拦了 `spawnSync`，不是发布包缺 ffmpeg。

### 4.3 「离线」这句怎么验的（别夸大）

不是拔网线，而是逐条排掉联网需求：

- 分词词典在包内（`kuromoji/dict/`，16.97MB），`check-release.mjs` 用包内路径 `build` tokenizer 成功 → 不需要下载词典；
- 英汉词典缺失只影响释义文案，digest / Word / 接口都正常（4.1 的英文 19 条、日文 6 条即是证明）；
- whisper 模型缺失只影响「视频没字幕」那条路（需要 ffmpeg + 模型，本来就要用户自备）；
- 全程唯一会发网络请求的功能是 **B 站抓取** 与 **`下载词典.cmd`**，发布包不带任何「首启联网」逻辑。

**仍属未验**：真断网环境下的实际启动（本轮没有可用的断网手段）。

---

## 5. 用户 m01535 要求核实的两点

### 5.1 取消按钮怎么提前拿到 taskId

- **保留** `POST /api/run/fetch`（等完成才返回，老契约不变，只是结果里多一个 `taskId`）。
- **新增** `POST /api/run/fetch/start`：立刻返回 `{ok:true, taskId, task}`，后台跑 `runFetchJob`，不 await。
- 前端 `doFetch()` 改为「start 拿 id → `busyTask={id}` → `waitTask(id)` 每 700ms 轮询 `/api/tasks?id=`」，取消按钮直接用 `busyTask.id`；**不猜「最新任务」，也不看任务列表第一条**。原来的 `watchTasks()` 已删除。
- 任务结束后 `finished` 表保留 10 分钟（`TASK_TTL_MS`），所以「刚跑完就轮询」不会查不到。
- 测试（`test/t6-tasks.test.js` 13 项）：start 立即返回且 <1500ms、此时 `done:false`、用该 id 取消能 abort 到真任务、轮询同一 id 能拿到 `task.result.ok`、老接口契约未变、做完后 `/api/tasks` 为空。

### 5.2 `.asr-stage` 可写性与磁盘输出锁

- 新增 `ensureWritableDir(dir)`：`mkdirSync` 后写探针文件 `.w-<pid>-<ts>` 再删。失败抛 `STAGE_UNWRITABLE`，message「暂存目录不可写：<dir>（<系统码>）」，并给三条可操作 `hint`（把模型移到可写目录 / 用 `stageDir` 指定别处 / 改目录权限）。`transcribe`、`transcribeSync`、`checkWhisper` 探针**三处都先过这一关**，失败时不起子进程。
- 输出锁：`claimOutput(out, tag)` 用 `openSync(lock,'wx')`（O_EXCL）落盘 `${out}.lock`（写 pid / tag / 时间），**跨进程互斥**；进程内再用 `committing` Map 挡同进程并发。**锁在转写一开始就抢**（`transcribe` 与 `transcribeSync` 都是先抢再跑），不是等产物验证完——所以第二路不会白跑一遍 GPU 才失败。
- 测试（`test/t6-asr.test.js` 32 项）：暂存目录被同名文件挡住 → `STAGE_UNWRITABLE` + hint ≥3 条 + 未起子进程；hang 模式在子进程执行期间断言 `${out}.lock` 存在且含 `process.pid`、结束后锁已清；别人留下的 `.lock` → `OUTPUT_CONFLICT` 且不起子进程、不删别人的锁；两路争同一输出 → 后到者立刻失败（< 25ms）。

---

## 6. 本轮测试与体检

| 项 | 结果 |
|---|---|
| 全量回归（当前包，2026-11-11 最终） | **286 项 / 286 通过 / 0 失败 / 0 跳过** |
| 编码体检 | `node tools/check-encoding.mjs`：120 个文件通过 |
| 干净环境自检 | 11 组 34 项全部 ✔（当前包重跑一遍仍全绿） |
| 插件契约 | 9 工具参数全部 OK |

---

## 7. 真实环境验收：六格全过，但有一格「过的是链路不是质量」

（明细见 `docs/evidence-t6.md` 第 4 节）

1. **CLI 端到端 2 项** —— ✅ `t5-entry` 10/10，5 种非法语言退出码都是 2。
2. **`runFfmpeg` 真 spawn 4 项** —— ✅ `t6-asr` 32/32，`skipped 0`。
3. **whisper 真转写** —— ✅ 中文音频（20s → 3.2s，7 条 SRT）+ 日语人声两段（30.9s / 68.4s）全跑通。
   ⚠️ 但**日语识别质量只能算「部分正确」**：短词、长音、促音、撥音区分不足，还出现整句幻觉
   （`docs/evidence-t6-real-ja-speech5.txt`）。链路可用 ≠ 质量可用 —— 这条已经写进界面
   （语言=日语 + 勾语音识别时出现红框提醒，真浏览器探针断言 2 项）、抓取日志、`发布说明.md`、
   `使用说明.md`、`README.md` 与验收总表，不再只是文档里的脚注。
4. **真实浏览器** —— ✅ Edge headless + CDP 12/12，截图 `docs/evidence-browser-ja.png`。
5. **真实 B 站成功流程** —— ✅ 10/10：弹幕 1406 条、语音识别 9s、产物齐全、digest 102 词条、Word 22KB。
6. **真实 B 站执行中取消** —— ✅ 取数阶段 `CANCELLED` + 转写阶段 `TRANSCRIBE_CANCELLED`（1059ms 收尾、
   子进程已死、无 .part/.lock、`.asr-stage` 清空、旧产物不受损），同目录重启成功。证据 `docs/evidence-t6-real-bili.txt`。

**仍然不能宣称「版本验收完成」的两件事**（都不是代码缺陷，是环境覆盖）：

- **不挂梯子时的 CDN 直连未验**：本轮全部下载都是经 `upos-sz-mirrorali` 镜像完成的，
  直连 `cn-sh-fx-01-03.bilivideo.com` 与 `cos` 镜像在这台机器上都 TLS 握手失败。
  普通用户没有梯子，这条必须在无代理环境再跑一次 `node tools/probe-audio-dl.mjs BV1GJ411x7h7` 才能下结论。
- **B 站日文字幕轨**：13 个样本都没返回日文字幕轨，需登录态再验（不影响 whisper 路径）。

---

## 8. 打包时踩到的三个坑

1. **.NET `ZipFile.CreateFromDirectory` 写反斜杠条目名**。第一版这样打出来的包，用 .NET 自己读是正常的（它宽容），
   但 zip 规范要求 `/`；换到 macOS / Linux 解压就是一坨名字里带 `\` 的单文件。已改成自己写 zip，并在打包后回读校验。
2. **旧 python 打包脚本不带 `node_modules`**。旧包 2.6MB 看着漂亮，但用户机器上 `import kuromoji` 直接失败——
   日语功能等于没发。这次按 lock 装闭包，包大 7 倍，换来「解压即用」。
3. **staging 第一版 62.58 MB**。两块肥肉：`kuromoji/test/`（22MB，上游测试夹具）与 `app/public/img/*-sheet.png`（15MB，抠图前原图）。
   剔掉后 26.39 MB，zip 19.39 MB——该留的词典一个字节没动。

## 9. 本轮触及的文件

改：`README.md`、`发布说明.md`、`AGENTS.md`（第七节）、`src/asr.js`、`src/app/server.js`、`src/bili.js`、`src/cli.js`、`src/fetch.js`、`src/index.js`、`src/run.js`、`src/pipeline.js`、`src/ja/index.js`、`src/wordlists/{store,import}.js`、`app/public/{app.html,app.js}`、`test/t6-asr.test.js`、`test/t6-tasks.test.js`、`test/t4-meanings.test.js`、`test/t5-entry.test.js`、`tools/probe-browser.mjs`
新增：`tools/pack-release.mjs`、`tools/check-release.mjs`、`src/ja/entrykey.js`、`test/entrykey-compat.test.js`、`tools/probe-entrykey-format.mjs`、`tools/migrate-entrykey.mjs`、`tools/probe-real-whisper.mjs`、`tools/probe-browser-real.mjs`、`tools/probe-ja-speech.mjs`、`tools/probe-bili-subs.mjs`、`tools/probe-bili-real-flow.mjs`、`tools/probe-audio-dl.mjs`、`samples/ja-audio/practice5.ogg`、`samples/ja-audio/practice6.ogg`、`docs/evidence-t7.md`、`docs/evidence-entrykey.md`、`docs/evidence-t6-real-ja-speech5.txt`、`docs/evidence-t6-real-ja-speech6.txt`、`docs/evidence-t6-real-bili.txt`
删除：`tools/pack-release.py`、`tools/test-release.py`
