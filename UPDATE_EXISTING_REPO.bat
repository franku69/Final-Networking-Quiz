@echo off
setlocal
cd /d "%~dp0"
echo.
echo PACKET QUEST - UPDATE EXISTING GITHUB REPOSITORY
echo ------------------------------------------------
where git >nul 2>nul || (echo Git is not available in PATH.& pause & exit /b 1)
if not exist .git (echo This folder is not the cloned Git repository. Copy these updated files into your existing Networking-Quiz folder first.& pause & exit /b 1)
if exist PRIVATE_PACKET_QUEST_SECRETS.txt (echo ERROR: PRIVATE_PACKET_QUEST_SECRETS.txt is inside the repo. Move it out before continuing.& pause & exit /b 1)
echo Checking staged changes...
git add -A
git status
choice /C YN /M "Commit and push these changes now"
if errorlevel 2 exit /b 0
git commit -m "Fix GitHub Pages setup and optimize live quiz"
if errorlevel 1 echo No new commit was created. Continuing to push current branch.
git branch -M main
git push -u origin main
if errorlevel 1 (echo Push failed. Read the Git output above.& pause & exit /b 1)
echo.
echo Push complete.
echo IMPORTANT: GitHub Settings ^> Pages ^> Deploy from a branch ^> main ^> /docs ^> Save
pause
