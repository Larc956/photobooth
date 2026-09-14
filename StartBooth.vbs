Set WshShell = CreateObject("WScript.Shell")

' 1. Start the Node server completely hidden in the background (0 = hide window)
WshShell.Run "cmd /c node server.js", 0, False

' 2. Wait 2 seconds for the server to boot up
WScript.Sleep 2000

' 3. Open standard Chrome, maximized, with kiosk silent printing enabled
WshShell.Run "chrome --kiosk-printing --start-maximized http://localhost:3000"

Set WshShell = Nothing