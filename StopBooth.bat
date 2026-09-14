@echo off
echo Shutting down the Photobooth server and tunnel...
taskkill /F /IM node.exe >nul 2>&1
taskkill /F /IM cloudflared.exe >nul 2>&1
taskkill /F /IM ngrok.exe >nul 2>&1
echo Done!
timeout /t 2 >nul