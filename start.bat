@echo off
rem Double-click to play Splat Fighter: starts the local server and opens the browser.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1" -Port 8080 -Open
