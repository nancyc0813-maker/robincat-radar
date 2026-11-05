Set sh = CreateObject("WScript.Shell")
d = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = d
' V104-ELEC: check electron.exe first; if it is missing (download failed), explain in Chinese instead of a system error.
' Chinese text is built with ChrW() so this file stays plain ASCII (no encoding problems on any Windows language).
exe = d & "\node_modules\electron\dist\electron.exe"
If Not CreateObject("Scripting.FileSystemObject").FileExists(exe) Then
  m = ChrW(32599) & ChrW(23486) & ChrW(29483) & ChrW(38647) & ChrW(36798) & ChrW(30340) & ChrW(26700) & ChrW(38754) & ChrW(35270) & ChrW(31383) & ChrW(20803) & ChrW(20214) & ChrW(65288) & "Electron" & ChrW(65289) & ChrW(27809) & ChrW(26377) & ChrW(35013) & ChrW(22909) & ChrW(65292) & ChrW(25152) & ChrW(20197) & ChrW(25171) & ChrW(19981) & ChrW(24320) & ChrW(35270) & ChrW(31383) & ChrW(12290)
  m = m & vbCrLf & ChrW(24120) & ChrW(35265) & ChrW(21407) & ChrW(22240) & ChrW(65306) & ChrW(36830) & ChrW(19981) & ChrW(19978) & " GitHub" & ChrW(65292) & ChrW(19979) & ChrW(36733) & ChrW(22833) & ChrW(36133) & ChrW(12290) & ChrW(24341) & ChrW(25806) & ChrW(19981) & ChrW(21463) & ChrW(24433) & ChrW(21709) & ChrW(65292) & ChrW(29031) & ChrW(24120) & ChrW(22312) & ChrW(32972) & ChrW(26223) & ChrW(36816) & ChrW(34892) & ChrW(12290)
  m = m & vbCrLf & ""
  m = m & vbCrLf & ChrW(20462) & ChrW(22909) & ChrW(30340) & ChrW(26041) & ChrW(27861) & ChrW(65288) & ChrW(20108) & ChrW(36873) & ChrW(19968) & ChrW(65289) & ChrW(65306)
  m = m & vbCrLf & "1. " & ChrW(32593) & ChrW(32476) & ChrW(27491) & ChrW(24120) & ChrW(21518) & ChrW(65288) & ChrW(25110) & ChrW(24320) & " VPN" & ChrW(65289) & ChrW(65292) & ChrW(20877) & ChrW(25191) & ChrW(34892) & ChrW(19968) & ChrW(27425) & ChrW(12300) & ChrW(19968) & ChrW(38190) & ChrW(23433) & ChrW(35013) & ".bat" & ChrW(12301)
  m = m & vbCrLf & "2. " & ChrW(25163) & ChrW(21160) & ChrW(65306) & ChrW(25171) & ChrW(24320) & ChrW(12300) & ChrW(21629) & ChrW(20196) & ChrW(25552) & ChrW(31034) & ChrW(31526) & ChrW(12301) & ChrW(65288) & "cmd" & ChrW(65289) & ChrW(65292) & ChrW(20381) & ChrW(24207) & ChrW(36755) & ChrW(20837) & ChrW(19979) & ChrW(38754) & ChrW(19977) & ChrW(34892) & ChrW(65292) & ChrW(27599) & ChrW(34892) & ChrW(25353) & " Enter" & ChrW(65306)
  m = m & vbCrLf & "cd /d """ & d & """"
  m = m & vbCrLf & "set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
  m = m & vbCrLf & "npm ci --registry=https://registry.npmmirror.com"
  MsgBox m, 48, ChrW(32599) & ChrW(23486) & ChrW(29483) & ChrW(38647) & ChrW(36798)
  WScript.Quit 1
End If
sh.Run """" & exe & """ """ & d & """", 1, False
