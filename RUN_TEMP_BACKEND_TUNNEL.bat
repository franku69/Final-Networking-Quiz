@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
if not exist "backend\.env.local" (
  echo Private settings are not configured yet.
  echo Run SETUP_LOCAL_BACKEND.bat first.
  pause
  exit /b 1
)
for /f "usebackq tokens=1,* delims==" %%A in ("backend\.env.local") do set "%%A=%%B"
py -3 -c "import cryptography" >nul 2>&1
if errorlevel 1 py -3 -m pip install -r backend\requirements.txt || goto :fail
py -3 backend\tunnel_launcher.py --online
exit /b %errorlevel%
:fail
echo Setup failed.
pause
exit /b 1
