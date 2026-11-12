# vocab-digest · 弹幕字幕 → 词汇 Word（英语 / 日语）

把一条视频（或一堆字幕、弹幕）变成**能打印、能背的词表**。给它一个 B 站链接，它会自己去取字幕；没有字幕就用本地 whisper 转写；然后切词、还原词形、标读音与词性、按标签分章，最后出一份 Word。全程本地运行，不联网翻译、不耗 token。

适合：**看剧/看课/看动画学语言的人**。日语支持片假名 + 平假名读音与 `unknown` 标记（词典外的词保留原形、不编造读音）；英语接 ECDICT 77 万词条离线词典。

三种用法，按需挑一个：**Web 界面**（双击「词汇库」图标，本地手账式界面）、**命令行**（`vocab-english digest ...`）、**DSH 插件**（9 个 `vocab_*` 工具，让 AI 帮你跑完整条链路）。

读网页/视频的**弹幕**与**字幕**，抽出单词，按**标签分类**整理成 Word 文档。
英语路径只用 Node 内置模块；日文分词用 `kuromoji`（Apache-2.0，词典随发布包分发，解压即可离线分词）。
可以单独当命令行用，也可以作为 DSH 插件被 `PTC` 方式调用。

```
弹幕/字幕文件
   ↓ 解析（json / xml / srt / vtt / ass / txt）
清洗（去 URL、群号、@、HTML、零宽字符、刷屏重复）
   ↓ 切词 → 词形还原（runs/running → run）
过滤（停用词 + 已掌握词 + 排除正则 + 最低词长/词频）
   ↓ 打标签（词性 / 难度 / 来源 / 频次）
分章 → 生成 docx（原生 OOXML，不依赖 Word）→ 自检
```

> 不想读源码？直接跳到 **[从零开始（拿到代码后怎么跑）](#从零开始拿到代码后怎么跑)**。

## 功能一览

- **输入**：B 站字幕 JSON、弹幕 XML、srt / vtt / ass / txt；也可以直接贴 B 站视频地址，自动抓字幕和弹幕
- **没有字幕怎么办**：内置 ffmpeg 的 whisper 滤镜做语音识别（598 秒视频 64 秒转完，约 9 倍实时）
- **词形还原**：`runs / running / ran` 合成一个词条，不规则动词、`-ies / -ves / -es` 都处理
- **离线英汉词典**：接了 ECDICT（77 万词条），查词 1 毫秒，**不联网、不耗 token**
- **按标签看**：词性 / 难度 / 来源 / 频次四个维度，可以切换分章方式
- **Word 输出**：封面、目录、按标签分章、每个词条带音标 + 释义 + 原文用法（附时间戳）+ 剑桥词典超链接
- **Web 界面**：蓝白学习手账，导入弹窗、词条笔记抽屉、收藏本和手机页签；词条每次展示 50 条，搜索覆盖全部结果
- **个人词表**：可以新建多张表、导入导出、重命名；不同视频用不同词表

## 从零开始（拿到代码后怎么跑）

### 需要什么

| 项目 | 要求 | 说明 |
|---|---|---|
| 系统 | Windows 10 / 11 | 界面和启动器按 Windows 写的；引擎本身跨平台 |
| Node.js | **20 或更高** | 去 https://nodejs.org 下 LTS 版，一路下一步即可 |
| ffmpeg | 可选 | 只在「视频没有字幕、需要语音识别」时才用 |

### 第一步：拿到代码

```bash
git clone https://github.com/legalhigh181/vocab-digest.git
cd vocab-digest
```

或者直接下载 ZIP 解压。

### 第二步：装词典（强烈建议，一次就够）

没有词典也能跑，但词条会缺中文释义。仓库里**不含**词典数据（63 MB），用脚本自己下：

```powershell
powershell -ExecutionPolicy Bypass -File tools\download-dict.ps1
```

它会从 GitHub 下载 ECDICT 到 `data\ecdict.csv`，然后自检大小是不是 66009548 字节。

### 第三步：跑一次看看

```powershell
# 初始化词表（第一次需要）
node bin\vocab-english.js init

# 用仓库自带的测试数据跑一遍
node bin\vocab-english.js digest test\fixtures --run-id demo

# 结果在 runs\demo\vocab.docx
```

### 第四步：开始用

两种方式，任选：

**方式 A：Web 界面（推荐）**

```powershell
node bin\vocab-app.js --cwd . --port 7788
```

浏览器打开 http://127.0.0.1:7788/ ，点「导入一段视频」，粘 B 站地址并选择语言，点「抓取字幕」。在工作台阅读词条，右侧可生成 Word 词表。

想让它像普通软件一样双击打开，跑一次安装脚本，桌面就会多一个「词汇库」图标：

```powershell
powershell -ExecutionPolicy Bypass -File tools\install-shortcuts.ps1
```

**方式 B：命令行**

```powershell
# 一个目录里的所有字幕/弹幕
node bin\vocab-english.js digest "D:\某期视频\"

# 只有视频、没有字幕
node bin\vocab-english.js transcribe 视频.mp4 --out 视频.srt
node bin\vocab-english.js digest 视频.srt
```

### 语音识别要准备的模型（可选）

ffmpeg 自带 whisper 滤镜，但模型要自己下（465 MB）：

```
https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin
# 国内镜像：https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-small.bin
```

放到项目根目录的 `models\ggml-small.bin`，就会被自动找到。跑 `node bin\vocab-english.js status` 可以确认能不能用。

### 常见问题

| 现象 | 原因 / 解法 |
|---|---|
| 双击快捷方式图标是白纸 | Windows 读不了**含中文路径**里的 ico。安装脚本会自动把图标复制到 `%LOCALAPPDATA%\VocabDigest\`（纯英文路径）；如果是手动建的快捷方式，按这个思路改 |
| 词条没有中文释义 | 没装 ECDICT 词典，见第二步；或这个词词典里没有，点词条上的「剑桥」在线查 |
| 抓 B 站字幕失败 | 需要联网；分 P 视频要指定 `--page`；大会员专属视频抓不到 |
| 语音识别很慢 | 没走 GPU。检查 ffmpeg 是否是带 CUDA 的版本；或换 `ggml-base.bin`（更快但没那么准） |

## 桌面客户端（推荐给日常使用）

双击桌面上的 **「词汇库」** 图标即可。它会做三件事：

1. 后台把本地服务拉起来（不弹黑框）
2. 用 Edge / Chrome 的**应用模式**开一个独立窗口 —— 没有地址栏和标签页，看着就像个原生软件
3. 服务已经在跑就直接开窗口，不会重复启动

| 文件 | 作用 |
|---|---|
| `客户端.vbs` | 静默启动器（快捷方式指向它），**编码必须是 UTF-16LE，否则中文会编译报错** |
| `bin/vocab-client.js` | 真正的逻辑：探活 → 起服务 → 开应用窗口；找不到 Edge/Chrome 就退回默认浏览器 |
| `app/public/img/vocab.ico` | 快捷方式图标（从 Q 版头像转的，16–256 多尺寸） |
| `启动词汇库.cmd` | 想看得见日志时用这个（会留一个控制台窗口） |

浏览器配置目录放在 `%LOCALAPPDATA%\VocabDigest\client-profile`，不塞进项目里（否则编码体检会去扫浏览器缓存）。

## 快速开始（命令行）

```powershell
cd "C:\Users\18169\Documents\工作区 2\vocab-digest"

# 1) 初始化词表（只在第一次需要；也可以随时手改 data/ 下的文件）
node bin\vocab-english.js init

# 2) 一条龙：解析 → 抽词 → 出 Word → 自检
node bin\vocab-english.js digest "D:\某期视频\"

# 3) 看看结果
node bin\vocab-english.js status
node bin\vocab-english.js report 20261108-123456
```

产物在 `runs/<runId>/`：

| 文件 | 内容 |
|---|---|
| `vocab.docx` | 成品 Word |
| `digest.json` | 中间结果（词条、标签、章节、统计，可复现） |
| `report.json` | 自检报告 |
| `run.json` | 运行元信息（输入哈希、参数、耗时） |
| `decisions.json` | 人工/翻译回写的词性与释义（可选） |

## 支持哪些输入

| 扩展名 | 来源 | 说明 |
|---|---|---|
| `.json` | B站字幕 | `{"body":[{"from","to","content"}]}` |
| `.xml` | B站弹幕 | `<d p="时间,...">内容</d>` |
| `.srt` / `.vtt` | 通用字幕 | 按时间轴切条 |
| `.ass` / `.ssa` | 番剧字幕 | 取 `Dialogue:` 行 |
| `.txt` | 纯文本 | 按行/句切 |

目录会递归展开；B站抓取（`source.bilibili`）默认关闭，需要自己在普通终端里联网下载后再丢进目录。

**没有字幕怎么办？** 视频只有硬字幕（烧在画面里）或者压根没字幕时，用 `transcribe` 走语音识别——见下一节。

## 从 B 站取数（`fetch`）

```bash
vocab-english fetch "https://www.bilibili.com/video/BV1xx?p=2" --no-asr
```

### 两个弹幕开关是分开的

这是之前踩过的坑：早期只有「抓不抓」，没有「用不用」，结果弹幕会被顺手混进词频榜。

| 开关 | 默认 | 管什么 |
|---|---|---|
| `--no-danmaku` | 抓 | 要不要**下载**弹幕文件 |
| `--with-danmaku` | 不参与 | 下载到的弹幕要不要**进 digest** |

所以「只有弹幕的视频」（没台词）必须显式加 `--with-danmaku`，否则会明确报错告诉你怎么开，而不是悄悄给你一个空结果。

### 分 P 与跳转

- `?p=2` 或 `--page 2` 指定分 P；**不存在的 P 会直接报错**「这个视频没有第 9 P（共 3 P）」，不会退回第 1 P。
- 返回的 `inputs` 一定是**真实存在的文件路径**（可以直接喂给 `digest`）；
  带 `.p2` 的那种名字只出现在 `labels` 里，是给人看的展示标签。
- `meta.json` 里记着 `page` / `pageTitle` / `cid` / `playUrl`，界面上点句子的时间点就是靠它跳到正确的分 P。

### 分片与失败可见

弹幕按 B 站返回的**真实分片索引**取（`DmSegConfig` 的 `page_size` / `total`），
并发上限默认 4（`--concurrency N` 可调）。失败分三种呈现，绝不会伪装成「零条弹幕」：

| 情况 | 表现 |
|---|---|
| 索引接口失败 | 报错，`stage: index` |
| 部分分片失败 | 返回已有弹幕 + `warning: "N/M 个分片下载失败，弹幕可能不完整"` |
| 全部分片失败 | 报错，`stage: segments` |


## 语言（T1：契约与词表隔离）

分析语言由 `language` 参数决定：`en`（英语，默认）或 `ja`（日语，`jp` 是别名）。

```bash
vocab-english digest 某日剧.srt --language ja
```

| | 英语 `en` | 日语 `ja` |
|---|---|---|
| 词表目录 | `data/` | `data/ja/`（完全独立） |
| 最短词长 | 3 | **1**（日语无空格，`猫`、`手` 要保留） |
| 词表文件 | stopword / known / base / pos / 词形例外 | stopword / known |
| 英文资源 | 需要 | **不加载、不要求** |

要点：

- 两套词表**绝不混读** —— 切到日语不会因为你没装英文 `pos.json` 而报错，反之亦然。
- 路径写错（如 `--language fr`）直接报 `INVALID_LANGUAGE`，不会猜、不会回退到英语。
- 落盘的 `digest.json` / `run.json` 带 `language` 与 `schemaVersion: 2`；**没有 `language` 字段的旧结果按 `en` 读**，老数据不会坏。
- 用户显式写在 `config.local.json` 或命令行里的 `minLen` / `minFreq` 永远优先于语言默认值。

> 日语这条链路已经可用：kuromoji 分词 → 基本形还原 → 片假名/平假名读音 → 词性，`--language ja` 是完整路径。
> 三条已知限制：①kuromoji 对多读音词只取首选（「日本」标 `ニッポン`，不是 `ニホン`）；②词典外的词（人名、造词）保留表面形并标 `unknown`，**读音留空而不编造**；③日文首版不抽短语（英语的 PMI 与空格 n-gram 不适用于日语）。
>
> **日语语音识别的质量限制（必须说清）**：链路能跑通 ≠ 识别准。用 `ggml-small.bin` 转两段母语发音练习
> （30.9s / 68.4s，Public Domain，`samples/ja-audio/`）做过人工对照：短词对约八成，但长音、促音、撥音「ん」的
> 区分基本丢失，还出现过整句幻觉。发音练习也不等于自然对话——真实对话（语速、背景音、方言）只会更难。
> 所以日语 ASR 结果**必须人工核对**；界面上（语言=日语 + 勾语音识别）与抓取日志里都有这条提示。


## 语音识别（视频没有字幕时）
本机 ffmpeg 自带 whisper.cpp 滤镜，不需要装 Python / torch / whisper 包。模型放 `models/`，默认 `ggml-small.bin`（465MB）。

```bash
# 1) 音视频 → srt（首次会加载模型，之后快）
vocab-english transcribe 视频.mp4 --out 视频.srt
# 只转一段试试：--start 120 --duration 60
# 慢/显存不够：--no-gpu；更准但更慢的模型：--model ggml-medium.bin

# 2) 再走正常流程
vocab-english digest 视频.srt
```

实测（RTX 5070 Laptop）：598 秒的听力视频用 `ggml-small.bin` 全部转完 **64 秒**，识别质量很好（大小写、标点、句读都对）。`vocab-english status` 会告诉你当前环境语音识别能不能用。

拿不到模型时用普通终端下载（本会话的 shell 没有外网）：

```
https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin
# 或镜像：https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-small.bin
```

模型放哪个目录都行，cwd 下有 `models/ggml-small.bin` 就会自动用；也可以用 `--model` 指绝对路径。

注意：识别出的字幕里常有 `(gentle music)`、`[MUSIC PLAYING]` 这类舞台提示，清洗阶段会自动剔掉，不用手动删。

## 命令一览

```
vocab-english init                       初始化 data/ 词表
vocab-english transcribe <音视频...>      语音识别出 srt 字幕
vocab-english digest <文件|目录...>       一条龙（解析→Word→自检）
vocab-english render --run <runDir>      只重出 Word（改完 decisions.json 用）
vocab-english by-tag [runId]             按标签导出可读清单
vocab-english translate [runId]          导出待翻译批次 JSON
vocab-english apply --run <dir> <json>   回写词性/释义后重出文档
vocab-english report [runId]             查看自检报告
vocab-english status                     历史运行、词表状态、语音识别可用性
```

常用选项：`--by pos,difficulty,source,freq`（分章维度）、`--min-len`、`--min-freq`、`--title`、`--data-dir`、`--json`；transcribe 另有 `--out`、`--model`、`--language`、`--start`、`--duration`、`--no-gpu`。

## 按标签查看（m00186 的「标签分类 + 切换查看类型」）

每个词会同时打上四种标签，标签是**并列**的（一个词可以同时属于多个来源）：

| 维度 | 取值 |
|---|---|
| `pos` 词性 | 名词 / 动词 / 形容词 / 副词 / 短语 / 专有名词 / 数词 / 其他 |
| `difficulty` 难度 | 基础词（命中 `data/base/base.txt`）/ 进阶词 / 未标注 |
| `source` 来源 | 具体文件名（字幕、弹幕分别一章） |
| `freq` 频次 | 高频（≥5 次）/ 中频（2-4 次）/ 低频（1 次） |

三种「按标签看」的方式：

1. **Word 里换分类**：`--by difficulty`（或 `pos,source`）重新生成，章节结构随之切换。
   文档开头还有一张「标签索引」表，列出每个标签有多少词。
2. **导出清单**：`by-tag <runId> --dim difficulty --tag difficulty:basic` 出一份 txt。
3. **插件里切换**：`vocab_by_tag`（`output=txt|docx|both`）。

## 自己维护词表（`data/`）

首次运行自动生成，**已存在的文件永不覆盖**：

| 文件 | 作用 |
|---|---|
| `data/stopword.txt` | 停用词（不进正文）。一行一个，空格/逗号分隔也认 |
| `data/known/known.txt` | 已掌握的词（直接过滤掉） |
| `data/base/base.txt` | 基础词（用于「难度」标签，`docx.includeBase=false` 时不单独成章） |
| `data/pos.json` | 词性表 `{"word":"n."}`，优先级最高 |
| `data/lemmatize.exceptions.json` | 词形还原例外（`us` 不是 `u` 的复数之类） |
| `data/lemmatize.freqrank` | 可选词频表，用于候选排序 |

把生词加进 `known.txt` 就不会再出现在文档里；想强制某个词性，写进 `pos.json`。

## 作为 DSH 插件

`src/index.js` 导出 Cordis 插件（`inject = ['tools']`），注册 9 个工具：

| 工具 | 作用 |
|---|---|
| `vocab_transcribe` | 音视频 → srt（ffmpeg 内置 whisper，GPU 约 4~9 倍实时） |
| `vocab_fetch` | 从 B 站取数：有字幕轨下字幕，没有就下音频转写；返回的 `inputs` 直接喂给 `vocab_collect` |
| `vocab_plan` | 体检：词表齐不齐、输入能不能识别、本次参数是什么（不写文件） |
| `vocab_collect` | 解析 + 抽词，产出 `runs/<runId>/digest.json`，给出标签分布与高频词 |
| `vocab_translate` | `mode=export` 导出待翻译批次；`mode=apply` 回写词性/释义并重出 Word |
| `vocab_build_docx` | 生成/重生成 Word + 自检报告，可用 `by` 换分章维度、`language` 覆盖语言 |
| `vocab_by_tag` | 按标签查看（导出 txt 或按该维度重出 Word） |
| `vocab_wordlist` | 自建词表：list / create / rename / activate / import / fromRun / add / digestFrom |
| `vocab_status` | 词表状态、历史运行、语音识别可用性 |

接入 profile（`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`）：

```yaml
- insert:
    - id: vocab-digest
      name: 'dsh-vocab-digest'
      config:
        cwd: 'C:\Users\18169\Documents\工作区 2\vocab-digest'
        by: 'pos'
        autoInit: true
```

> `dsh` 字段里已经声明了 `bundle.patch: ./cordis.patch.yml`，用 `dsh plugin add <本目录>` 安装时
> 会自动合并那份 patch。

## 自检做了什么

`digest` / `build_docx` 结束都会跑五类检查，任何一项失败都会在输出里点名：

- `zip`：docx 能读、CRC 对、9 个部件齐全
- `xml`：每个 XML 部件标签配对、没有裸 `&` / `<`
- `content/sections`、`content/stats`、`content/entries`：章节标题、统计数字、词条段落数都对得上
- `determinism`：同一份模型重渲染 `document.xml` **逐字节一致**（固定时间戳，生成时间只放封面）

## 开发

```powershell
# 全量测试（本机沙箱禁止子进程管道，必须加 --test-isolation=none 并显式列文件）
node --test --test-isolation=none test\*.test.js

# 编码体检（改过含中文的文件就跑；PowerShell 写入很容易变成 GBK 乱码）
node tools\check-encoding.mjs

# 插件输出契约校验（execute 返回的字段必须在 output.schema 里）
node tools\probe-t6-plugin.mjs
```

## 打包给别人用

```powershell
# 白名单打包：只挑 bin/ src/ app/ 与必要数据，带上 kuromoji 词典（约 17MB）和依赖，
# 不含 ECDICT 词典、语音模型、个人词表、运行记录
node tools\pack-release.mjs

# 解压到任意目录后做干净目录自检（34 项：结构、不夹带个人数据、离线分词、英文/日文 digest、Word、插件、本地服务）
node tools\check-release.mjs "D:\某个解压目录"
```

产物 `dist\词汇库-v1.0-windows.zip` 约 20MB，输出里会打印**字节数与 SHA-256**——对外说“哪个包”就用这串哈希，改了代码必须重打包并更新文档里的哈希。
接收方需要 **Windows + Node.js 20+**；双击 `安装.cmd` 建快捷方式，语音模型按 `发布说明.md` 自行补。

## 已知限制

- **英文释义靠 ECDICT**：没装词典时词条只有词性；词典里没有的词可以点「剑桥」在线查，或用 `vocab_translate` 回写。
- **词性靠启发式**：POS 表命中优先，其次人工回写，最后才按后缀猜（`-tion`→名词 之类），
  猜错就用 `decisions.json` 纠正。
- **所有全大写短词（≤4 字母）当刷屏丢弃**：`LOL`、`OMG` 这类；更长的大写词只有在同一批里
  出现过小写写法时才收。
- **语音识别只认口播**：BGM 很响、多人抢话、口音重时准确率会掉；术语/人名容易识别错（错的形式
  会作为新词条出现，可以加进 `stopword.txt`）。whisper 对音乐段会输出舞台提示，已自动清洗。
- **日语 ASR 质量有限**：`ggml-small.bin` 对长音、促音、撥音「ん」的区分基本丢失，偶发整句幻觉；
  实测发音练习 14 词对 8–9 个。日语结果必须人工核字幕，想更准只能换更大的模型。
- **日语释义覆盖低**：`data/ja/meanings.json` 目前只有示例条目，绝大多数日文词条没有中文释义。
- **只支持英语与日语**：`--language en|ja`，其它语言直接报 `INVALID_LANGUAGE`，不猜、不回退。
