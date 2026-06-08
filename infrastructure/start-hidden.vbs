' Start AI Brain PM2 in hidden mode (no CMD windows)
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c cd /d C:\Users\bogia\Downloads\my-ai-brain && pm2 start ecosystem.config.cjs", 0, False
