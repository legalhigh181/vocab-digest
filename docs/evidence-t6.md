# T6 取证记录

**状态：实现完成；真实环境验收已完成 4 项，余 2 小格待补（日语音频真转写、真 B 站链接抓取）。**
下面每一条都注明「怎么验的」和「还差什么」。没有在真实环境跑过的，一律记为待验收，不记通过。

> 2026-11-11 补记：T7 的打包与干净目录验证已完成（见 `docs/evidence-t7.md`）。
> 本机 spawn 放开后，原先只能跳过的 6 项真子进程测试已真实跑通，真实浏览器验收也补上了
> （Edge headless + CDP，12/12）。仍未完成的是：**日语音频的真 whisper 转写**（手上没有日语音频素材）、
> **对着真 B 站链接的抓取 + 取消**。因此整个版本仍**不标记验收完成、不对外发布**。

---

## 0 · 环境限制（先看这个，否则数字会被误读）

> **2026-11-11 更新：本机 spawn 通道已经放开。** 之前被拦的 6 项测试这次真的跑起来了
> （`tests 285 / pass 285 / fail 0 / skipped 0`），第 3、4 节据此重写。
> 下表保留为「当时的环境」，因为它解释了为什么早先只有 268 项能跑、为什么要写手工替代证据。

当时（T6 实现期）本机 DSH 沙箱内：

| 能力 | 结果 | 复现方式 |
|---|---|---|
| Node `spawn` / `spawnSync` 起任意子进程 | **EPERM** | `node tools/probe-spawn.mjs` |
| PowerShell `Start-Process` 起外部进程 | **Access is denied** | 见下方注 |
| 当前 pwsh 进程直接调外部命令（`& ffmpeg @args`） | 可用 | `probe-real-ffmpeg.ps1` |
| 工作区外写文件（如 D 盘） | 默认拒绝，需提升权限 | — |

因此：

- **`--test-isolation=none` 是必需的**：默认隔离模式会为每个测试文件起子进程，沙箱下直接失败。
- 早先那 6 项用 `spawn` 起真子进程的测试只能登记为「跳过」：
  - `test/t5-entry.test.js` 2 项（CLI 端到端）
  - `test/t6-asr.test.js` 4 项（`runFfmpeg` 真 spawn）
- 轮询 `probe-spawn.mjs` 的结论当时是：`spawnSync` 与 `spawn` 均报 `EPERM`，`child-marker=false`。
  现在同一个探针返回 `child-marker=true`，所以这 6 项已转为真实执行并通过。

> 注：`Start-Process ffmpeg` 报的是 `Win32Exception: Access is denied`，但同一时间
> `& ffmpeg @args` 能正常出文件——说明不是 ffmpeg 装坏了，是起进程那条通道被拦。
> 这是把探针改成直调的原因。

---

## 1 · 六条要求的落实情况

### ① Web/插件转写走异步子进程，长 ASR 不阻塞探活

- `src/asr.js` 的 `transcribe()` 是 `async`，内部用 `runFfmpeg()`（`spawn` + 事件回调），
  不再是 `spawnSync`。同步版 `transcribeSync()` 只留给 CLI。
- `src/fetch.js:238`、`src/index.js:814` 都是 `await transcribe(...)`；`src/cli.js:294` 用 `transcribeSync`。
- `src/app/server.js` 的 `/api/run/fetch` 在 `startTask()` 里跑，请求不会卡住别的路由。

**怎么验的**：`test/t6-tasks.test.js`「取数任务在跑时服务仍然能响应（探活不被阻塞）」——
注入一个要 60 秒才结束的 `fetchVideo`，期间请求 `/api/state` 必须 2 秒内返回。

**还差**：真 ffmpeg 转写期间的服务探活，本机 spawn 被拦，未验。

### ② 超时、取消、子进程清理、有限 stderr、明确错误码

错误码集中在 `ASR_ERRORS`（`src/asr.js:42`）：
`INPUT_MISSING / INPUT_TOO_LARGE / WHISPER_UNAVAILABLE / FFMPEG_MISSING / MODEL_MISSING /
TRANSCRIBE_FAILED / TRANSCRIBE_TIMEOUT / TRANSCRIBE_CANCELLED / TRANSCRIBE_NO_OUTPUT /
TRANSCRIBE_EMPTY / OUTPUT_CONFLICT / MODEL_LANGUAGE_MISMATCH / INVALID_LANGUAGE / FFMPEG_PATH_UNSAFE`。

- 超时：默认 `duration*8000+120000`，无 duration 则 30 分钟；超时后 `killTree()`（Windows 用 `taskkill /T /F`）。
- 取消：`AbortSignal` 一路传进 `runFfmpeg`，取消返回 `TRANSCRIBE_CANCELLED`。
- stderr：`DEFAULT_STDERR_LIMIT = 64K`，超出部分丢弃并记 `stderrDropped`；报错时只带回末尾 4000 字节。
- 清理：暂存产物在 `finally` 里删；锁文件在 `process.on('exit')` 兜底清。

**怎么验的**：`test/t6-asr.test.js` 用注入的 `ffmpegTarget` 覆盖 ok/empty/none/crash/hang/noisy 六种形态，
分别断言 `TRANSCRIBE_EMPTY` / `TRANSCRIBE_NO_OUTPUT` / `TRANSCRIBE_FAILED` / `TRANSCRIBE_TIMEOUT` /
`TRANSCRIBE_CANCELLED` 以及 `stderr` 被截到 4000 字节以内。

**还差**：真进程被杀、真超时，本机 spawn 被拦，未验。

### ③ 独立临时输出 + 退出码与解析双判定，不误认旧 SRT

- 每次转写在 `<模型目录>/.asr-stage/t_<token>.srt` 下产出（`safeStageName()` 只留 `[A-Za-z0-9._-]`）。
- 判定顺序：`spawnError → cancelled → timedOut → status!==0 → 产物不存在 → srtHasContent()`，
  任一不过就失败并清理暂存。
- `srtHasContent()` 要求「有时间轴 + 至少一行非空非序号文本」，空壳 SRT 不算成功。

**怎么验的**：`test/t6-asr.test.js` 的 `empty` / `none` 两个用例 + `srtHasContent` 单测。

### ④ 中文、空格、单引号、跨盘；日文拒绝英文专用模型

**这是 m01027 要求重做的部分。** 原来的做法是把输出目录 `relative()` 后转正斜杠塞进滤镜，
在 Windows 上跨盘时 `relative()` 会返回带盘符冒号的路径，正斜杠救不了滤镜转义，所以改成：

> **滤镜目的地永远是纯 ASCII 相对名 `<暂存目录名>/t_xxx.srt`，子进程 cwd 固定在模型目录。**
> 用户路径只会出现在 `-i <输入路径>` 这种普通参数里（进程 argv 数组，不过 shell）。

- 输入路径经 `inputArg()`：绝对路径直接用（只拒 `\r\n\0`）；相对路径拒 `-` 开头并加 `./` 前缀。

**怎么验的（真 ffmpeg，不是替身）**：`tools/probe-real-ffmpeg.ps1`，结果落在
`docs/evidence-t6-real-ffmpeg.txt`：

```
OK   生成测试音频（真 ffmpeg 编码器可用）   exit=0 size=32078
OK   同盘 · 中文 + 空格路径                exit=0，目的地 = .asr-stage/t_probe_1_xxx.wav，产物 6478 字节
OK   跨盘（输入在 D 盘，模型目录在本盘）    exit=0，目的地 = .asr-stage/t_probe_2_xxx.wav，产物 6478 字节
OK   跨盘（模型目录在 D 盘，子进程 cwd 在另一盘） exit=0，目的地 = .asr-stage/t_probe_3_xxx.wav，产物 6478 字节
```

用的是**生产代码同一个** `inputArg()` / `safeStageName()` 构造参数，真 ffmpeg 真写文件。
素材路径含中文、空格、单引号（`it's a 测试/say 'hello'.wav`）。

**这条证据的边界**：它证明的是「路径怎么传给 ffmpeg、滤镜目的地怎么写、跨盘 cwd 能不能落盘」，
**不包括 whisper 滤镜本身**——whisper 要 GPU + 486MB 模型，单次跑数分钟，留给发布前验收补跑。

> 跨盘用例需要写到 D 盘。默认沙箱拒绝，本次是在提升权限后跑的；脚本 `finally` 里自清理，
> 已确认 `D:\vocab-digest-跨盘探针 中文`、`D:\vocab-digest-模型 跨盘` 均不存在。

日文与英语专用模型：`isEnglishOnlyModel()` 只认 `*.en.bin` 后缀（不靠名字猜），
命中时抛 `MODEL_LANGUAGE_MISMATCH`。**怎么验的**：`test/t6-asr.test.js` 三项——
日语 + `.en` 模型被拒且不产文件；同模型转英文放行；日语 + 多语种模型放行。

### ⑤ 下载流式 `.part` + 原子完成 + 有界重试 + 节流 + 取消

`src/bili.js` 的 `download()`：`Readable.fromWeb(res.body)` → `pipeline` → `<out>.part`，
完成后 `renameSync` 正式名；`content-length` 对不上判 `TRUNCATED` 并清 `.part`；
重试 `retries`（默认 2）+ 指数退避 `backoffMs`（默认 800）；4xx（除 408/429）不重试；
`signal` 取消返回 `CANCELLED`；目标已存在且未 `overwrite` → `OUTPUT_CONFLICT`。

**怎么验的**：`test/t6-asr.test.js` 五项（注入 `fetchImpl`，不出网）。

### ⑥ 并发目录/runId 隔离；旧的提交策略

`src/run.js`：

- `makeRunId()` = `YYYYMMDD-HHmmss-<4位随机>`。
- 自动分配：先建 `runRoot`，再 `mkdirSync(recursive:false)` 抢目录，撞车就换 ID（最多 32 次）。
- 显式 `runId`：**默认遇到已有目录就报 `RUN_DIR_CONFLICT`（reason: `exists`）**，
  要覆盖必须显式 `overwrite: true`；**正在跑的任务一律不许覆盖（reason: `busy`）**。
- `renderRun()` 外层也做同样的抢占。

**怎么验的**：`test/t6-tasks.test.js` 10 项，重点是：

- 「运行 ID 唯一性」：12 个并发 `runDigest` 的 `runId` 与 `runDir` **全部互不相同**，每个目录都有 `digest.json`。
- 「强制碰撞」：先把一个 ID 占掉，再让 ID 工厂第一次返回它 → 断言取了 2 次、撞车留痕、结果落在换出来的新 ID、
  原目录完好。
- 「显式 runId：默认不许覆盖」/「运行中带 overwrite 也抢不走」（用 `afterClaim` 钩子在占用窗口重入）。
- 「显式指定已存在的运行 ID 时必须报冲突，不能静默覆盖」（拒绝时 `digest.json` 字节不变）。

旧字幕的提交策略：

- **转写开始前不动旧文件**；转写全程旧字幕可读。
- 成功后先抢输出位置的锁（`claimOutput()`，落盘 `.lock` + 进程内占位），
  再 `copyFileSync` 到 `.tmp`、`renameSync` 覆盖——旧文件在 rename 那一瞬间才被替换。
- 失败只清自己的暂存，旧文件一个字节都不动。
- 同一个输出路径同时只允许一个转写：**一开始就占位置**，第二路立刻 `OUTPUT_CONFLICT`，
  不会白跑几分钟 GPU 才发现撞车。

**怎么验的**：`test/t6-asr.test.js` 的「整个转写过程中旧字幕一直可读，成功后才被一次替换」、
「转写失败时旧字幕不会被误认成新成果」、「目标已存在且没允许覆盖 → OUTPUT_CONFLICT，旧字幕一动不动」、
「同一输出路径被别的转写占着 → OUTPUT_CONFLICT」、「两个转写抢同一个输出：后到的立刻失败」。

---

## 2 · 异步改动的调用方核查（m01027 第 4 点）

`transcribe()` 由同步改成 Promise 后，逐一核对：

| 调用点 | 处理 | 结论 |
|---|---|---|
| `src/fetch.js:238` | `await transcribe({...})`，try/catch → `{ok:false, code, stderr}` | 正确 |
| `src/index.js:814` | `await transcribe({...})`，catch 包成带错误码的中文报错 | 正确 |
| `src/cli.js:294` | 用 `transcribeSync`（CLI 是前台进程，阻塞无副作用） | 正确，无 Promise 泄漏 |
| `src/app/server.js` | 通过 `fetchVideo()` 间接调用，已在 `await` 链上 | 正确 |

后台接口：

- `/api/run/fetch` 仍保持**等任务做完再返回**的旧契约（返回值结构不变，多带一个 `taskId`），
  **旧调用方不受影响**。
- 新增 `GET /api/tasks`、`GET /api/tasks?id=xxx`（查单个，结束后 10 分钟内仍可查到）、`POST /api/tasks/cancel`。
- 任务结束后把最终结果挂到 `task.result`，`publicTask()` 一并返回——轮询不会遇到「任务刚结束就查不到」。
- 前端 `app/public/app.js` 的 `doFetch()`：跑任务期间每秒轮询 `/api/tasks` 显示进度条，
  新增「取消抓取」按钮，失败信息写进日志框；结束后照旧把 `r.inputs` 交给 `/api/run/digest`。

**怎么验的**：`test/t6-tasks.test.js` 的探活、取消、取消不存在任务、两并发任务目录不同四项。
**还差**：真实浏览器里的轮询条与取消按钮，DOM 垫片只能证明逻辑，不能证明视觉与交互。

---

## 3 · 测试与体检

```
node --test --test-isolation=none test/<全部测试文件>
  tests 286 · pass 286 · fail 0 · skipped 0     ← 2026-11-11 最终（含语言贯通那条新测试）

node tools/check-encoding.mjs
  编码体检通过：123 个文件未发现乱码

node tools/probe-t6-plugin.mjs
  注册工具数：9，参数契约全部 OK（vocab_build_docx 含 language；vocab_transcribe 含 overwrite）
```

早先沙箱拦 spawn 时的数字是 `268 / 262 / 6 跳过`，那 6 项跳过从来不算通过；
现在它们真跑并全过，`skipped` 归零。

---

## 4 · 真实环境验收清单

| # | 项 | 怎么跑的 | 现状 |
|---|---|---|---|
| 1 | CLI 端到端 2 项 | `test/t5-entry.test.js` | **已通过**：10/10，含 5 种非法语言（xx/zh/jpn/EN_US/123）退出码都是 2 |
| 2 | `runFfmpeg` 真 spawn 4 项 | `test/t6-asr.test.js` | **已通过**：32/32，`skipped 0` |
| 3 | whisper 真转写（机制） | `node tools/probe-real-whisper.mjs --transcribe samples/BV1Z7xh6HEfD.p1/audio.m4s --language zh --seconds 20` | **已通过**：ffmpeg 有 whisper 滤镜、`ggml-small.bin` 465MB 加载成功、真转写 3.2s 出 7 条带时间轴 SRT（`docs/evidence-t6-real-whisper.txt`） |
| 4 | 日语人声真转写 + 人工对照 | `node tools/probe-ja-speech.mjs --set 5` / `--set 6` | **已跑通，但质量结论要说准**：两段 Public Domain 日语母语发音音频（30.9s / 68.4s）→ 真转写 → 日文 digest → Word，**7/7 断言通过**（15 / 27 条 SRT、22 / 18 个词条、offset 全部自洽、假名字符 62/64、拉丁 0、时间轴单调、`[未收录]` 标注正确）。**人工对照只能算「部分正确」**：practice5 的 14 词对约 8–9 个，玄米被切成「ゲン」「マイ」，还出现了一句 YouTube 式幻觉「専用本日の動画をご覧いただきありがとうございます。」；practice6 的长音、促音、撥音「ん」区分基本丢失。→ **日语 ASR 执行链路可用，ggml-small 的日语识别质量不足以宣称已验证**。证据 `docs/evidence-t6-real-ja-speech5.txt` / `...6.txt` |
| 5 | 真实浏览器：日文读音、未收录标记、语言选择、错误提示 | `node tools/probe-browser-real.mjs`（Edge headless + CDP） | **已通过 12/12**：真加载、运行列表 33 条、点日语运行后徽标 JA、卡片出片假名（コーヒー/トモダチ/…）、`.phon` 0 个、未收录 1；切英语后徽标 EN、`.phon` 46、`.reading` 0。截图 `docs/evidence-browser-ja.png` / `evidence-browser-en.png`，日志 `docs/evidence-browser-real.txt` |
| 6 | 真实 B 站：完整成功流程 | `node tools/probe-bili-real-flow.mjs` A 段 | **已通过 10/10**：start 22ms 拿到 taskId、弹幕 1406 条参与分析、语音识别 9s、转写期间 `/api/state` 25 次最慢 8ms、产物齐全（audio.p1.m4s / audio.p1.srt 84 条 / danmaku.txt / danmaku.xml / meta.json）、无 .part/.lock、digest 102 词条自检通过、Word 22KB |
| 7 | 真实 B 站：执行中取消（取数阶段 + 转写阶段） | 同上 B / C / D 段 | **已通过**：B 取数阶段取消 → `CANCELLED 下载音频失败：下载被取消`，音频未落盘、无 .part、旧 meta 要么原样要么是完整 JSON、无 ffmpeg 残留、无半截字幕；C 转写阶段取消 → `TRANSCRIBE_CANCELLED`，1059ms 收尾、whisper 已结束、`.asr-stage` 清空、无新字幕、服务仍正常；D 同目录重启成功（11s）。证据 `docs/evidence-t6-real-bili.txt` |

`app/public/index.html` 这个路径是旧的，实际入口是 `app/public/app.html`（服务端 `/` 会给它）。

---

## 5 · 已知限制

- **Meiryo 回退**：`LANGUAGE_DOC_DEFAULTS.ja.eastAsiaFont = 'Meiryo'`。日文 Windows 都带 Meiryo；
  非日文系统缺字时由 Word 自己回退，我们没有做字体探测。
- **词典次选读音**：kuromoji 只给一个读音，例如「日本」标的是 **ニッポン** 而不是 ニホン。
  原样透出，不做改写——错读音比没有读音更害人。
- **日语识别质量**：见清单第 4 项。`ggml-small.bin` 对短词、长音、促音、撥音区分不足，
  还会产生整句幻觉。链路（子进程、超时、取消、SRT 解析、digest、Word）都验过了，
  但**不能把「日语 ASR 质量已验证」写进结论**；要改善只能换更大模型或换解码参数，本轮不做。
- **B 站 CDN 直连**：本机（挂梯子状态下）直连 `cn-sh-fx-01-03.bilivideo.com` TLS 握手被重置，
  唯一的旧镜像 `upos-sz-mirrorcos` 也握手失败，只有 `upos-sz-mirrorali` 返回 200。
  已把镜像兜底改成数组（`src/bili.js` 的 `MIRROR_HOSTS` + `mirrorOf()` 返回数组），逐个试。
  **「不挂梯子时直连是否可用」尚未验证**——这条要单独测，否则不知道镜像兜底是在补网络环境还是在补产品缺陷。
- **kuromoji 体积**：约 17MB 词典，已随 ZIP 分发（解压即离线分词），包体因此到 19.39MB。
- **B 站日文字幕轨**：13 个样本里都没返回日文字幕轨，**不能据此断定 B 站没有**，需登录态再验。
  2026-11-11 试了两次「借登录态」，都没成：①第一次复制来的 Edge profile 里根本没有
  `SESSDATA` / `DedeUserID` / `bili_jct`（18 个 bilibili cookie 全是匿名的）；②用户重新登录后
  cookie 齐了（37 个，凭证三件套都在），但 Edge 对 cookie 用了**应用绑定加密**（`v20` 前缀 /
  `APPB` 密钥），离机用 DPAPI 解 `app_bound_encrypted_key` 被系统拒绝
  （`Key not valid for use in specified state`），复制 profile 给无头 Edge 也解不开，而真 profile
  目录上新版 Edge 又不允许开远程调试。
  **更要紧的是：之前「这几个样本没有字幕轨」的结论作废。** 匿名态下我多扫了排行榜 30 条 +
  按「日语字幕」搜索的 12 条，其中标题明写「CC字幕」「中日双语」「日文字幕」的视频
  全部返回 `code=0` 且字幕轨为空（`tools/probe-bili-subs-cookie.mjs` 还试了带
  `buvid3/buvid4` cookie，同样为 0）——这说明**未登录时字幕接口就是拿不到轨**，之前的空结果是假阴性。
  → 该格仍未验证，且**必须登录态才能验**；不影响 whisper 兜底路径。
- **取数会复用已有音频**：`src/fetch.js` 里 `if (!existsSync(audioPath))` 才下载，旧音频会被直接拿去转写。
  这是有意的缓存行为，但意味着「同一个样本目录里残留的音频」可能不是这次链接的音频。

## 6 · 本轮修掉的真实 bug

1. `src/docx/ooxml.js:284`：`${ea}` 把语言码当文本塞进 XML，`langXml` 从未拼进去 → `w:eastAsia` 语言标记不生效。
2. `src/config.js` 默认 `docx.fontCn: '等线'` 覆盖了日文默认字体 → 日文文档仍是等线。已删除默认值。
3. `src/run.js` 自动分配 runId 时没先建 `runRoot` → `ENOENT`。
4. `src/asr.js` 暂存目录建在了目标目录而不是子进程 cwd 下 → 滤镜相对路径落空。改成 `<模型目录>/.asr-stage`。
5. 输出占位时机太晚（验收后才抢）→ 两路转写白跑。改成一开始就占。
6. **语言没传进转写层**（`app/public/app.js` 的 `doFetch()`、`src/index.js` 的 `vocab_collect`）：
   `/api/run/fetch` 与 `fetchVideo` 收到 `language: undefined`，`src/fetch.js` 按 `opts.language ?? 'en'`
   用英语转写日语人声 → 英文 SRT → 日文分词 0 词条。用户用 `BV1KE4p6CERE` 实测复现。
   已补传 `language`，并加测试锁住；同段音频用 `--language ja` 重跑输出日文（31 条）。
