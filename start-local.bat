@echo off
title SlipPilot — Local Dev Server
color 0A

echo.
echo  ============================================
echo   SlipPilot  ^|  Local Development Server
echo  ============================================
echo.

:: Step 1 — Kill any process already on port 3000
echo  Stopping any existing server on port 3000...
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":3000.*LISTENING"') do (
  taskkill /PID %%a /F >nul 2>&1
)
timeout /t 1 /nobreak >nul

:: Step 2 — Open the browser after a short delay (runs in background)
echo  Opening browser in 4 seconds...
start /b cmd /c "timeout /t 4 /nobreak >nul && start http://localhost:3000/admin"

:: Step 3 — Start the server (stays open, shows all logs here).
:: server.js self-restarts on an OOM memory-safety trip (process.exit(1),
:: logged as "[OOM] ...MB — restarting") on the assumption that something
:: outside it brings the process back up. Plain `node server.js` does not —
:: once it exited, the whole app stayed down until someone noticed and
:: relaunched by hand (this is what "everything off" turned out to be).
:: The :runloop below is that missing piece: it restarts the server
:: automatically whenever it exits, unless you stop it yourself with Ctrl+C.
echo  Starting server...  (Ctrl+C to stop — auto-restarts on crash/OOM)
echo.
echo  -------------------------------------------
echo   App   ^>  http://localhost:3000
echo   Admin ^>  http://localhost:3000/admin
echo  -------------------------------------------
echo.
:runloop
node server.js
echo.
echo  [%date% %time%] Server exited (code %errorlevel%) — restarting in 2s... (Ctrl+C to stop)
timeout /t 2 /nobreak >nul
goto runloop
