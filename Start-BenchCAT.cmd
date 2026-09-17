@echo off
setlocal
cd /d "%~dp0"
title BenchCAT
echo Starting BenchCAT...
echo Project: %CD%
echo.

where pwsh.exe >nul 2>nul
if %errorlevel% equ 0 (
    pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-desktop.ps1"
) else (
    powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-desktop.ps1"
)

if errorlevel 1 (
    echo.
    echo BenchCAT failed to start. See the error above.
    pause
)
endlocal
