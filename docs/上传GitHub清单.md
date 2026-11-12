# 上传 GitHub 清单（vocab-digest）

> 写于 2026-11-12。目标：一次提交干净、别人 clone 下来能跑、不把模型/词典/个人数据塞进历史。
> 仓库：`https://github.com/legalhigh181/vocab-digest`（远端已配好，分支 `main`）

---

## 0. 仓库介绍（GitHub 页面用）

**About 一句话（≤350 字符，直接粘）**：

```
把 B 站视频/字幕/弹幕变成能打印的词汇 Word（英语/日语）。本地跑：自动取字幕、没字幕用 whisper 转写，kuromoji 分日文词，标读音与词性，按标签分章导出 docx。带本地 Web 界面、命令行和 DSH 插件。
```

**Topics（逐个加）**：

```
vocabulary  japanese  english  anki  subtitle  danmaku  bilibili  whisper  kuromoji  docx  nodejs  cli
```

> README 开头已经写了一段完整介绍（是什么、给谁用、三种用法），About 只是列表页那一行。

---

## 1. 该传的

| 分组 | 内容 | 大小 |
|---|---|---|
| 源码 | `src/`（含 `ja/`、`languages/`、`docx/`、`wordlists/`、`app/server.js`） | 0.5MB |
| 入口 | `bin/`（`vocab-english.js` / `vocab-app.js` / `vocab-client.js`） | 小 |
| 前端 | `app/public/`（html/css/js + 小图，**不含 `*-sheet.png` 原图**） | 约 2.5MB |
| 测试 | `test/`（21 个 `*.test.js` + `fixtures/` + `harness.mjs`） | 小 |
| 工具 | `tools/`（打包、体检、探针、下载词典脚本） | 0.3MB |
| 数据模板 | `data/` 下 6 个：`README.md`、`base/base.txt`、`colloquial.json`、`lemmatize.exceptions.json`、`pos.json`、`stopword.txt` | 小 |
| 文档 | `README.md`、`使用说明.md`、`发布说明.md`、`AGENTS.md`、`LICENSE` | 小 |
| 证据 | `docs/`（验收总表、交接文档、`evidence-*.md`、ADR、两张浏览器截图） | 1.9MB |
| 工程 | `package.json`、**`package-lock.json`**、`config.default.json`、`cordis.patch.yml`、`.gitignore` | 小 |
| 启动器 | `安装.cmd`、`启动词汇库.cmd`、`下载词典.cmd`、`客户端.vbs` | 小 |

合计约 **5MB 以内**，远低于 GitHub 的仓库体积建议（<1GB）。

## 2. 不该传的

| 不传 | 大小 | 原因 |
|---|---|---|
| `node_modules/` | 45MB | 有 lock 文件即可 `npm ci` 还原 |
| `models/ggml-*.bin` | 465MB | 单文件超过 GitHub 100MB 硬限，push 会被拒 |
| `data/ecdict.csv` | 63MB | 同上；已有 `tools/download-dict.ps1` |
| `samples/` | 211MB | 真实视频的音频/转写，只保留 `test/fixtures/` 小样例 |
| `runs/`、`build/`、`versions/`、`dist/` | — | 运行与打包产物 |
| `dist/*.zip` | 20MB | 成品走 **GitHub Release**（`tools/make-release.mjs`） |
| `app/public/img/*-sheet.png` | 15MB | 美术原图；成品小图已入库 |
| `data/wordlists/`、`data/known/known.txt`、`data/ja/known.txt` | — | 个人词表与学习进度 |
| `config.local.json` | — | 含本机绝对路径 |
| `*.m4s` `*.part` `*.lock` `*.log` `*.bak` | — | 临时/锁文件 |

以上都已经在 `.gitignore` 里（本次补了 `data/ja/known.txt` 和 `config.local.json` 两条）。

## 3. 上传前必做（按顺序）

机器上目前**没有 git**（PATH 里找不到），先装：<https://git-scm.com/download/win>，装完重开终端。

```powershell
cd 'C:\Users\18169\Documents\工作区 2\vocab-digest'

# 1) 确认忽略规则生效（这三条都应该输出路径 = 被忽略）
git check-ignore -v models samples data\wordlists data\ja\known.txt
git check-ignore -v config.local.json

# 2) 清理 .git 里 585MB 的不可达对象（之前误 add 模型/词典留下的；不影响推送内容，但没必要背着）
git gc --prune=now --aggressive

# 3) 看一眼将提交什么（必须没有 models/ samples/ runs/ node_modules/ *.zip）
git status --short
git add -A
git status --short | Measure-Object -Line        # 预期 130~140 个文件

# 4) 提交前自检：仓库里不该出现任何本机路径
git grep -n "C:\\Users\\18169" -- . ':!docs'      # docs 里有测试记录，可以留
git ls-files -s | ForEach-Object { ($_ -split '\s+')[3] } | Sort-Object | Select-Object -First 5

# 5) 提交并推送
git commit -m "feat(ja): 日语支持 + UI 优化 + 打包与验收证据"
git push origin main
```

## 4. 推送后要做的两件事

1. **建 Release**：Tag `v1.0`，附件传 `dist\词汇库-v1.0-windows.zip`（20MB，走 Release 不占仓库体积）。
   仓库里已有 `tools/make-release.mjs`（需要 GitHub token）可以先传 tag 再传附件，或者直接在网页上拖文件。
   Release 说明可直接用 `发布说明.md`。
2. **填 About**：把 §0 那句话粘进去，Topics 一个个加。这样别人在搜索结果里知道你这是什么。

## 5. 如果 push 被拒

| 报错 | 原因 | 处理 |
|---|---|---|
| `File XXX is 465.00 MB; this exceeds GitHub's file size limit of 100.00 MB` | 大文件进了提交 | `git rm --cached models/...`，确认 `.gitignore` 生效后 `git commit --amend` |
| `remote: error: GH001: Large files detected` | 大文件在历史里 | `git filter-repo --path models --invert-paths`（或重新 `git init` 只保留当前快照） |
| `failed to push some refs`（non-fast-forward） | 远端有你本地没有的提交 | `git pull --rebase origin main` 再 push |

> 当前本地历史只有 2 个提交、树里 115 个文件共 3.1MB，**没有大文件**，正常情况下不会触发上面任何一条。
> 那 428MB 的胖对象是“不可达”的，`git gc --prune=now` 之后就会消失，也不会被推送。

## 6. 提交后别人怎么跑（写给自己核对）

```powershell
git clone https://github.com/legalhigh181/vocab-digest.git
cd vocab-digest
npm ci                                  # 只装 kuromoji 及其 3 个依赖
powershell -ExecutionPolicy Bypass -File tools\download-dict.ps1   # 可选：英汉释义
node bin\vocab-english.js digest test\fixtures --run-id demo       # 出 runs\demo\vocab.docx
node bin\vocab-app.js --cwd . --port 7788                          # 或开界面
```

如果这一步跑不起来，说明有文件漏提交（最可能是 `package-lock.json`、`test/fixtures/` 或 `data/` 里的模板文件）。
