# vocab-digest · 弹幕字幕 → 英语词汇 Word

读网页/视频的**弹幕**与**字幕**，抽出英语单词，按**标签分类**整理成 Word 文档。
零第三方依赖（只用 Node 内置模块），可以单独当命令行用，也可以作为 DSH 插件被 `PTC` 方式调用。

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
- **Web 界面**：本地起服务，粘地址 → 抓字幕 → 挑词表 → 出 Word，全程点鼠标
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

浏览器打开 http://127.0.0.1:7788/ ，左侧粘 B 站地址，点「抓取字幕」，然后挑词表、点「出 Word」。

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

`src/index.js` 导出 Cordis 插件（`inject = ['tools']`），注册 7 个工具：

| 工具 | 作用 |
|---|---|
| `vocab_transcribe` | 音视频 → srt（ffmpeg 内置 whisper，GPU 约 4~9 倍实时） |
| `vocab_plan` | 体检：词表齐不齐、输入能不能识别、本次参数是什么（不写文件） |
| `vocab_collect` | 解析 + 抽词，产出 `runs/<runId>/digest.json`，给出标签分布与高频词 |
| `vocab_translate` | `mode=export` 导出待翻译批次；`mode=apply` 回写词性/释义并重出 Word |
| `vocab_build_docx` | 生成/重生成 Word + 自检报告，可用 `by` 换分章维度 |
| `vocab_by_tag` | 按标签查看（导出 txt 或按该维度重出 Word） |
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
# 测试（本机沙箱禁止子进程管道，必须加 --test-isolation=none 并显式列文件）
node --test --test-isolation=none test\parsers.test.js test\text.test.js test\engine.test.js test\docx.test.js test\run.test.js test\tags.test.js

# 插件输出契约校验（execute 返回的字段必须在 output.schema 里）
node test\harness.mjs
```

## 打包给别人用

```powershell
# 打一个不含 66MB 词典、不含语音模型、不含自己词表的干净包
# 做法：把 bin/ src/ app/ data/ tools/ 与根文件复制到临时目录，
#       删掉 data\ecdict.csv、data\wordlists、app\public\img\*sheet*.png、runs/ versions/ models/，
#       再用 Compress-Archive 压成 dist\词汇库-v1.0-windows.zip（约 3.3MB）
```

接收方需要 **Windows + Node.js 20+**；双击 `安装.cmd` 建快捷方式，词典和语音模型按 `发布说明.md` 自行选择是否补。

## 已知限制

- **没有内置英汉词典**：释义要么由 LLM 经 `vocab_translate` 回写，要么自己在 `data/pos.json` 维护。
  文档里没释义的条目只显示词性。
- **词性靠启发式**：POS 表命中优先，其次人工回写，最后才按后缀猜（`-tion`→名词 之类），
  猜错就用 `decisions.json` 纠正。
- **所有全大写短词（≤4 字母）当刷屏丢弃**：`LOL`、`OMG` 这类；更长的大写词只有在同一批里
  出现过小写写法时才收。
- **语音识别只认口播**：BGM 很响、多人抢话、口音重时准确率会掉；术语/人名容易识别错（错的形式
  会作为新词条出现，可以加进 `stopword.txt`）。whisper 对音乐段会输出舞台提示，已自动清洗。
- **只做英语**：`--language en` 是默认，识别的词表也是英文；其它语言不在本次范围。
