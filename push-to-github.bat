@echo off
REM Uploads this project to https://github.com/nidhigala1112-crypto/RDC-RMS
REM Needs Git for Windows (https://git-scm.com/download/win).
REM A browser window will ask you to sign in to GitHub the first time.
cd /d "%~dp0"

where git
if errorlevel 1 (
  echo Git is not installed. Install it from https://git-scm.com/download/win and run this file again.
  pause
  exit /b 1
)

if not exist .git git init
git config user.name "Nidhi Gala"
git config user.email "nidhi.gala@rdc.in"
git add .
git commit -m "RDC Recruitment Management System"
git branch -M main
git remote remove origin
git remote add origin https://github.com/nidhigala1112-crypto/RDC-RMS.git
git push -u origin main

echo.
echo Finished. If you saw an error above, send me a screenshot.
pause
