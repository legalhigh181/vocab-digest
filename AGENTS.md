# 开发备忘（给以后的自己 / 接手的人看）

这个文件记的是**踩过的坑和为什么这么写**，不是功能说明。功能看 `README.md`，给第一次用的人看 `使用说明.md`。

---

## 一、启动链路：为什么快捷方式指向 `wscript.exe` 而不是 exe

### 曾经的坑：坏 exe 静默失败

2026-11-08 我做「自包含 exe」时，往项目根目录放了一个 `词汇库.exe`（Node 的 SEA 半成品）。
`tools/install-shortcuts.vbs` 的逻辑是「**有 exe 就用 exe，没有才用 vbs**」，于是快捷方式指向了它。

双击后：

```
Node.js is only supported on Windows 10, Windows Server 2016, or higher.
```

进程立刻退出、**不弹任何对话框**。用户看到的就是「双击没反应」。

### 教训

1. **优先选中某个文件之前，先验证它真能跑。** 「文件存在」不等于「能用」。
2. **静默失败的进程 = 用户眼中的"坏了"。** 双击型程序挂掉时必须留下可见痕迹（哪怕是一句提示）。
3. **换掉一个启动器时，把旧的清理干净**（改名成 `.bad` 也行），别留在会被自动选中的路径上。
4. 现在的做法：`词汇库.exe` 改名成 `词汇库.exe.bad` 留在原地（不删，便于排查），快捷方式改回 `wscript.exe + 客户端.vbs`。

### 现在的正确链路

```
桌面「词汇库」.lnk
  → C:\Windows\System32\wscript.exe  "...\客户端.vbs"
  → 客户端.vbs 静默跑 node bin\vocab-client.js
  → vocab-client.js：检查服务是否活着 → 没活就 spawn 服务 → 用 Edge/Chrome 的 --app 模式开窗口
```

**如果你想重新做 exe 自包含**：做完先手动双击跑一遍，确认能起服务、能开窗口，**再**让安装脚本去认它。

---

## 二、图标：路径含中文会让 Windows 读不到

### 症状

桌面快捷方式显示白纸，换机器也复现。

### 排查走过的弯路（别重走）

| 试过什么 | 结果 | 是否根因 |
|---|---|---|
| 以为 ico 格式坏了（PNG 帧 → DIB 帧） | 改了，还是白纸 | ✗ |
| 以为 `wscript.exe` 宿主没图标 | 换 exe 宿主，还是白纸 | ✗ |
| 以为图标缓存坏了 | 删 iconcache + 重启 explorer，还是白纸 | ✗ |
| **用 PIL 验证 ico** | **PIL 说没问题，但实际上 Windows 读不了** | ✗ 错误的验证手段 |

### 真正的根因

**ico 文件路径里带中文（`工作区 2`），Windows 的图标加载器读不到。**

对照实验（决定性证据）：

```
同一个 vocab.ico：
  C:\vocabtest\vocab.ico                    → 快捷方式显示正常 ✓
  C:\Users\18169\Documents\工作区 2\...\vocab.ico → 白纸 ✗
```

### 修法

安装脚本**先把 ico 复制到纯英文路径**，再让快捷方式指向那个副本：

```vbs
icoLocal = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\VocabDigest\vocab.ico"
fso.CopyFile root & "app\public\img\vocab.ico", icoLocal, True
lnk.IconLocation = icoLocal & ",0"
```

### 教训

- **验证工具必须和真实用户走的同一条路。** 用 PIL 读 ico ≠ 用 Windows 资源管理器读 ico。
- 遇到「文件明明存在但系统不认」，**先怀疑路径里有非 ASCII 字符**。
- ico 建议用经典 DIB 格式（`tools/make-ico.py`），兼容性最好。

---

## 三、编码：写文件前先想清楚谁会读它

| 文件类型 | 必须的编码 | 为什么 |
|---|---|---|
| `.ps1` | UTF-8 **带 BOM** | PS5.1 否则按 GBK 读，中文全乱 |
| `.vbs` | **UTF-16LE + 单个 BOM** | VBScript 按 ANSI 读 UTF-8 会报 `Invalid character` |
| `.cmd` | **纯 ASCII，无 BOM** | cmd 遇到 BOM 会把第一行当命令；中文会被按字节切片截断 |
| `.js` / `.mjs` / `.json` | UTF-8 无 BOM | Node 默认 |

### 三个反复踩的坑

1. **`.cmd` 里绝对不能写中文。** 就算 `chcp 65001`，cmd 处理批处理文件时仍按字节切片，实测会把 `https://nodejs.org` 截断成 `'org' is not recognized`。逻辑全搬进 `.vbs`，`.cmd` 只留一行 `cscript`。
2. **反复「读 utf16le → 写 utf16le」会叠加 BOM**（实测出现 3 个 U+FEFF）。统一用 `node tools/build-vbs.mjs <源.vbs> <目标.vbs>` 从 UTF-8 源码重新生成。
3. **cscript 的输出是 GBK**（中文系统）。用 UTF-8 去解码看是乱码，**容易误判成脚本坏了**。验证方法：

```powershell
cmd /c "chcp 936 >nul & cscript //nologo tools\install.vbs ""%CD%"" > log.txt 2>&1"
[System.IO.File]::ReadAllText("$PWD\log.txt", [Text.Encoding]::GetEncoding(936))
```

### 检查仓库里有没有乱码

```bash
node tools/check-encoding.mjs
```

会扫 `src/ bin/ test/ app/ data/ samples/` 和根目录的配置文件，命中黑名单字或可疑字节就报。

---

## 四、`node -e` 和 shell 的陷阱

1. **不要在 PowerShell 里用 `-replace` / `Set-Content` 改含中文的 `.js`** —— 中文会变成 `鏂囨湰` 这类乱码，且很难发现（语法可能仍然合法）。用 `write` / `edit` 工具整文件改。
2. **`node -e` 里带引号、反斜杠、`\r\n` 的字符串会被 PowerShell 吞**，写法再小心也容易错。**一律写成 `.mjs` 文件再 `node file.mjs`。**
3. **`.mjs` 里不能用 `require`**（`package.json` 是 `"type": "module"`），会报 `require is not defined in ES module scope`。用 `import fs from 'node:fs'`。
4. **`node --test` 必须带 `--test-isolation=none` 并显式列出文件**，否则沙箱下 `spawn EPERM`。

---

## 五、Word（docx）生成

- **不要用 Python `python-docx` 去验证生成的 docx**（本机没装）。用 `node:zlib` + 手写 zip 的方式读回来校验 CRC 和 XML 结构。
- **不要用 Word COM 打开 docx 做自动验证** —— 会卡在对话框上挂死（实测 kill 过 WINWORD）。
- 生成时间等易变字段不要进 `document.xml`，否则「同输入重跑逐字节一致」的自检永远不过。

---

## 六、网络

- **PowerShell 的 TLS 经常被拦**（`Invoke-WebRequest` 对 baidu/bilibili 全挂），但 **node 的 `fetch` 走自己的 TLS 栈，通常正常**。联网的事优先用 node。
- 要走代理时，给 node 设环境变量（进程环境默认没有 `HTTP_PROXY`）：

```powershell
$env:HTTPS_PROXY="http://127.0.0.1:7897"; $env:HTTP_PROXY="http://127.0.0.1:7897"
```

- GitHub 抽风时（`ECONNRESET`）先探测 `https://api.github.com/zen`，直连和代理各试一次再判断。

---

## 七、发布

```bash
node tools/pack-release.mjs                    # 白名单打包 → dist/词汇库-v1.0-windows.zip（含 node_modules）
node tools/pack-release.mjs --no-zip           # 只做 build/release-staging，调打包用
node tools/check-release.mjs "解压目录"         # 对着解压出来的副本跑干净环境自检（结构 + 英文/日文 digest + Word + 插件 + 本地服务）
```

- 打包是**白名单制**，不是「全复制再删」。要加文件必须显式加进 `DIRS` / `ROOT_FILES` / `TOOLS` / `DATA_FILES`。
- `node_modules` **不从开发机整份复制**：按 `package.json` 的 dependencies 走闭包，逐个比对 `package-lock.json` 版本，版本不符直接报错。kuromoji 的 `test/`、`demo/`、`example/` 会被剔除（约 22MB，运行时用不到），`dict/`（16.97MB）必须留——那是「解压即离线分词」的本钱。
- 发布包里**不能有**：`runs/`、`versions/`、`models/`、`samples/`、`data/wordlists/`、`data/ecdict.csv`、`build/`、任何 `.exe`、`*-sheet.png`（设定原图，抠好的小图才是线上用的）。
- `data/known/known.txt` 与 `data/ja/known.txt` 写**空模板**，绝不能带个人进度。
- `check-release.mjs` 只做进程内调用（不起子进程）：受限环境里 Node `spawn` 会被拦，那是环境限制，不该混进发布结论。测试**必须用全新解压的副本**——它自己会往目录里写 `runs/`。
- 上传到 GitHub Release 时**附件名用 ASCII**（`vocab-digest-v1.0-windows.zip`）。用中文名会被 GitHub 弄丢字符（实测 `词汇库-v1.0-windows.zip` 变成 `-v1.0-windows.zip`）。
