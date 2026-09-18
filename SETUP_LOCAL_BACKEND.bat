@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
if exist "backend\.env.local" (
  echo backend\.env.local already exists. Delete it first if you want to replace the private values.
  pause
  exit /b 0
)
echo.
echo Packet Quest private local setup
echo Paste the two values from PRIVATE_PACKET_QUEST_SECRETS.txt.
echo This creates backend\.env.local, which .gitignore excludes from GitHub.
echo.
set /p BANK=PACKET_BANK_KEY: 
set /p TEACHER=PACKET_TEACHER_KEY: 
if "%BANK%"=="" goto :bad
if "%TEACHER%"=="" goto :bad
(
  echo PACKET_BANK_KEY=%BANK%
  echo PACKET_TEACHER_KEY=%TEACHER%
  echo PACKET_ALLOW_PAGES_ORIGINS=1
  echo PACKET_DATA_DIR=backend/runtime
)>"backend\.env.local"
echo.
echo Saved private local settings to backend\.env.local
echo DO NOT upload that file to GitHub.
pause
exit /b 0
:bad
echo Missing value. Nothing was saved.
pause
exit /b 1
