@echo off
title Photobooth Launcher
color 0A

:: 0. Clean up any stuck processes from previous runs
taskkill /F /IM node.exe >nul 2>&1
taskkill /F /IM cloudflared.exe >nul 2>&1
taskkill /F /IM ngrok.exe >nul 2>&1

:: 1. Check if Node.js is installed on this PC
node -v >nul 2>&1
IF %ERRORLEVEL% NEQ 0 (
    echo =======================================================
    echo ERROR: Node.js is not installed on this computer!
    echo =======================================================
    echo The Photobooth requires Node.js to run.
    echo Press any key to open the download page...
    pause >nul
    start https://nodejs.org/
    exit
)

:: 2. Check if the app needs to be installed/updated
IF NOT EXIST "node_modules\" (
    echo =======================================================
    echo First Time Setup: Installing required files...
    echo Please wait, this may take a minute.
    echo =======================================================
    call npm install
    echo.
    echo Installation Complete!
)

:: 3. Launch the Photobooth invisibly using your VBS script
echo Starting Photobooth...
wscript StartBooth.vbs