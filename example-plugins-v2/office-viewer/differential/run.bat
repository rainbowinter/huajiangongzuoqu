@echo off
REM 差分验收包的一键入口（绕过 PowerShell 执行策略）。
REM   run.bat              全量
REM   run.bat --skip-build 只重跑对照
setlocal
set KIT=%~dp0
python "%KIT%tools\run_all.py" %*
exit /b %ERRORLEVEL%
