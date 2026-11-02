@echo off
rem NRG: weekly copy of the server backups from the Hetzner Storage Box to this computer.
rem Double-click it once a week. It asks for the Storage Box password (it is not saved).
rem Change BOX below once to your Storage Box username (example: u123456).
setlocal
set BOX=u123456
for /f %%d in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set TODAY=%%d
set DEST=%USERPROFILE%\NRG-backups\%TODAY%
if not exist "%DEST%" mkdir "%DEST%"
echo.
echo Copying the NRG backups to %DEST%
echo Type the Storage Box password when asked:
scp -P 23 -r %BOX%@%BOX%.your-storagebox.de:nrg-backups/* "%DEST%"
if errorlevel 1 (
  echo.
  echo Something went wrong. Check the username in this file and the password, then try again.
) else (
  echo.
  echo Done. Keep this folder private: it holds the server's keys and the database.
)
pause
