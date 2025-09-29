@echo off
echo Starting Nova with persistent tunnel...

REM Start Nova in background
start "Nova Server" cmd /c "cd /d %~dp0 && npm start"

REM Wait a moment for Nova to start
timeout /t 3 /nobreak >nul

REM Start localtunnel with automatic restart
:restart_tunnel
echo Starting localtunnel...
lt --port 3000 --subdomain nova-stephen
echo Tunnel disconnected. Restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto restart_tunnel