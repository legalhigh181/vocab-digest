' 词汇库 安装程序（完整逻辑都在这里）
'
' 为什么不写在 .bat 里：cmd 处理带中文的批处理时，切换 chcp 65001 之后
' 仍然会按字节切片，导致中文和 URL 被截断错位。
' 用 VBScript 写就完全没有这个问题。
'
' 由根目录的「安装.cmd」调用。文件必须存成 UTF-16LE + BOM。

Option Explicit

Dim fso, shell, root

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

If WScript.Arguments.Count >= 1 Then
  root = WScript.Arguments(0)
Else
  root = fso.GetParentFolderName(WScript.ScriptFullName)
End If
If Right(root, 1) <> "\" Then root = root & "\"

Main

Sub Main()
  Echo ""
  Echo "  词汇库 - 安装"
  Echo "  ================================"
  Echo ""

  ' ── 1. 找 Node.js ──────────────────────────────────
  Dim nodeExe
  nodeExe = FindNode()
  If nodeExe = "" Then
    Echo "  [X] 这台电脑还没装 Node.js。"
    Echo ""
    Echo "      词汇库是用 Node.js 写的，需要一个运行环境（装一次就好）。"
    Echo "      步骤："
    Echo "        1) 打开 https://nodejs.org/zh-cn/download"
    Echo "        2) 下载标着 LTS 的 Windows 安装包（.msi），一路「下一步」"
    Echo "        3) 装完关掉这个黑窗口，再双击一次「安装.cmd」"
    Echo ""
    Echo "      现在打开下载页面吗？(y / 直接回车跳过)"
    If Ask("") Then
      shell.Run "https://nodejs.org/zh-cn/download", 1, False
      Echo "      已经打开了，装完再双击「安装.cmd」。"
    End If
    Echo ""
    Pause
    WScript.Quit 1
  End If

  ' ── 2. 版本检查 ────────────────────────────────────
  Dim ver, major, q
  q = Chr(34)
  ver = Trim(ShellExec("cmd /c " & q & q & nodeExe & q & " -v" & q))
  major = ParseMajor(ver)
  Echo "  [ok] Node.js " & ver
  Echo "       (" & nodeExe & ")"
  If major < 20 Then
    Echo ""
    Echo "  [X] 版本太旧了（需要 20 或更高，当前是 " & major & "）。"
    Echo "      去 https://nodejs.org/zh-cn/download 装新版，覆盖安装即可。"
    Echo ""
    Pause
    WScript.Quit 1
  End If

  ' ── 3. 找启动器 ────────────────────────────────────
  If Not fso.FileExists(root & "客户端.vbs") And Not fso.FileExists(root & "词汇库.exe") Then
    Echo "  [X] 找不到启动器 客户端.vbs"
    Echo "      zip 可能没解压完整，重新解压一次试试。"
    Echo ""
    Pause
    WScript.Quit 1
  End If

  ' ── 4. 建快捷方式 ──────────────────────────────────
  Echo "  正在创建快捷方式..."
  Dim rc, q2
  q2 = Chr(34)
  rc = shell.Run("cscript //nologo " & q2 & root & "tools\install-shortcuts.vbs" & q2 & " " & q2 & root & q2, 0, True)
  If rc <> 0 Then
    Echo "  [X] 快捷方式没建成（返回码 " & rc & "）。"
    Echo ""
    Pause
    WScript.Quit 1
  End If

  ' ── 5. 词典提示 ────────────────────────────────────
  If Not fso.FileExists(root & "data\ecdict.csv") Then
    Echo ""
    Echo "  [提示] 还没有本地英汉词典 data\ecdict.csv（约 66MB）。"
    Echo "         没有它也能用，只是多数词条只有英文释义。"
    Echo "         现在下载吗？(y / 直接回车跳过)"
    If Ask("") Then
      shell.Run "cscript //nologo " & q2 & root & "tools\download-dict.vbs" & q2 & " " & q2 & root & q2, 1, True
    End If
  End If

  ' ── 6. 自检 ────────────────────────────────────────
  Echo ""
  Echo "  正在做一次自检..."
  rc = shell.Run("cmd /c cd /d " & q2 & root & q2 & " && node bin\vocab-english.js status >nul 2>&1", 0, True)
  If rc = 0 Then
    Echo "  [ok] 程序能正常运行"
  Else
    Echo "  [!] 自检没通过（返回码 " & rc & "），可以先双击桌面图标试试。"
  End If

  Echo ""
  Echo "  装好了！以后双击桌面的「词汇库」就能打开。"
  Echo ""
  Pause
End Sub

' ── 输出 ────────────────────────────────────────────
' 用 StdOut.WriteLine 而不是 WScript.Echo：
' 前者能原样输出 UTF-8，后者在 cscript 下会走系统代码页（中文系统是 GBK）。
Sub Echo(s)
  On Error Resume Next
  WScript.StdOut.WriteLine s
End Sub

' 让窗口停下来，用户能看到结果
Sub Pause()
  On Error Resume Next
  shell.Run "cmd /c pause", 1, True
End Sub

Function Ask(prompt)
  Dim ans
  If prompt <> "" Then
    ans = InputBox(prompt, "词汇库 安装")
  Else
    ' 用原生的「按 y 确认」对话比 InputBox 可靠，不会卡在后台
    ans = ""
  End If
  Ask = (LCase(Trim(ans)) = "y")
End Function

Function FindNode()
  Dim p, candidates, i
  FindNode = ""

  On Error Resume Next

  ' 1) 先问 PATH
  p = Trim(ShellExec("cmd /c where node 2>nul"))
  If p <> "" Then
    FindNode = Split(p, vbCrLf)(0)
    FindNode = Trim(FindNode)
    If fso.FileExists(FindNode) Then
      On Error GoTo 0
      Exit Function
    End If
    FindNode = ""
  End If

  ' 2) 再看几个常见安装位置（刚装完 Node 时 PATH 还没刷新）
  candidates = Array( _
    shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe", _
    shell.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\nodejs\node.exe", _
    shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\nodejs\node.exe")
  For i = 0 To UBound(candidates)
    If fso.FileExists(candidates(i)) Then
      FindNode = candidates(i)
      On Error GoTo 0
      Exit Function
    End If
  Next
  On Error GoTo 0
End Function

Function ShellExec(cmdline)
  Dim exec, out
  On Error Resume Next
  Set exec = shell.Exec(cmdline)
  If Err.Number <> 0 Then
    ShellExec = ""
    Exit Function
  End If
  out = ""
  Do While Not exec.StdOut.AtEndOfStream
    out = out & exec.StdOut.ReadLine & vbLf
  Loop
  ShellExec = Trim(out)
End Function

Function ParseMajor(ver)
  Dim s, parts
  ParseMajor = 0
  s = Trim(ver)
  If Left(s, 1) = "v" Then s = Mid(s, 2)
  parts = Split(s, ".")
  If IsNumeric(parts(0)) Then ParseMajor = CInt(parts(0))
End Function
