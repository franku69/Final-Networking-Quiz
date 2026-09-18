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
if errorlevel 1 (
  echo Installing the one Python dependency for the encrypted private question bank...
  py -3 -m pip install -r backend\requirements.txt || goto :fail
)
echo.
echo Local test site: http://127.0.0.1:8765/
echo Local teacher CRM: http://127.0.0.1:8765/teacher/
echo Keep this window open while testing.
py -3 backend\server.py --host 127.0.0.1 --port 8765
exit /b %errorlevel%
:fail
echo Setup failed.
pause
exit /b 1
