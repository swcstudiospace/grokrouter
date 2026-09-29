@echo off
rem Double-click installer for an extracted official GrokRouter source ZIP or clone.
rem The execution-policy override applies to this one PowerShell process only.
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-windows.ps1"
set "GROKROUTER_EXIT=%ERRORLEVEL%"
echo.
echo You can close this window.
pause
exit /b %GROKROUTER_EXIT%
