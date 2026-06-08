@echo off
echo Installing AI Brain as Windows Service (hidden mode)...
cd /d C:\Users\bogia\Downloads\my-ai-brain

:: Create a VBS wrapper to run PM2 hidden
echo Set WshShell = CreateObject("WScript.Shell") > run-hidden.vbs
echo WshShell.Run "cmd /c cd /d C:\Users\bogia\Downloads\my-ai-brain && pm2 start ecosystem.config.cjs", 0, False >> run-hidden.vbs

:: Create Scheduled Task to run at startup
schtasks /create /tn "AI-Brain" /tr "wscript.exe \"C:\Users\bogia\Downloads\my-ai-brain\run-hidden.vbs\"" /sc onstart /rl highest /f

echo.
echo AI Brain service installed!
echo It will start automatically on Windows startup.
echo.
echo Commands:
echo   Start:   pm2 start ecosystem.config.cjs
echo   Stop:    pm2 kill
echo   Status:  pm2 list
echo   Logs:    pm2 logs
pause
