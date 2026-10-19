@echo off
REM ============================================================
REM  Karim's - Internet Access Launcher
REM  Starts the server + a public Cloudflare Tunnel so phones
REM  on mobile data can reach POS / Kitchen / Finance.
REM ============================================================
setlocal
cd /d "%~dp0"

echo.
echo  ============================================
echo   KARIM'S - Starting server and public tunnel
echo  ============================================
echo.

REM --- 1. Start the app server ---
echo [1/2] Starting server on port 3000...
start "Karims Server" /min cmd /c "cd /d "%~dp0" && node server.js"
timeout /t 4 /nobreak >nul

REM --- 2. Start the public tunnel ---
echo [2/2] Opening public tunnel (this takes ~15 seconds)...
if not exist "%TEMP%\karims-tunnel.log" mkdir "%TEMP%" >nul 2>&1
del "%TEMP%\karims-tunnel.log" >nul 2>&1

start "Karims Tunnel" /min cmd /c ""C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:3000 --no-autoupdate 2> "%TEMP%\karims-tunnel.log""

echo.
echo  Waiting for the public address...
timeout /t 20 /nobreak >nul

echo.
echo  ============================================
echo   YOUR PUBLIC ADDRESS
echo  ============================================
findstr /i "trycloudflare.com" "%TEMP%\karims-tunnel.log"
echo.
echo  Open these on any phone using mobile data:
echo.
echo    Customer menu  : https://YOUR-ADDRESS-HERE/
echo    POS / Cashier  : https://YOUR-ADDRESS-HERE/pos
echo    Kitchen Display: https://YOUR-ADDRESS-HERE/kitchen
echo    Manager        : https://YOUR-ADDRESS-HERE/manager
echo    Finance        : https://YOUR-ADDRESS-HERE/finance
echo    Admin          : https://YOUR-ADDRESS-HERE/admin
echo.
echo  IMPORTANT:
echo   - Keep this window and the two small server windows OPEN.
echo   - If the address changes, re-run this file.
echo   - The tunnel stops if your laptop sleeps or loses internet.
echo.
pause