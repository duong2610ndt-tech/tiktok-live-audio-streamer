Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Lấy thư mục hiện tại của file script
currentDir = fso.GetParentFolderName(WScript.ScriptFullName)
exePath = fso.BuildPath(currentDir, "TikTokRecorder.exe")

' Đặt làm thư mục làm việc chính
WshShell.CurrentDirectory = currentDir

' Kiểm tra nếu có file .exe đã build thì chạy .exe, ngược lại chạy node index.js (dành cho phát triển)
If fso.FileExists(exePath) Then
    WshShell.Run """" & exePath & """", 0, false
Else
    WshShell.Run "node """ & fso.BuildPath(currentDir, "index.js") & """", 0, false
End If

' Đợi 1.5 giây để server Node.js kịp khởi động
WScript.Sleep 1500

' Tự động mở trình duyệt tới Dashboard
WshShell.Run "cmd /c start http://localhost:3456", 0, false
