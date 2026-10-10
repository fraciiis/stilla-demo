@echo off
setlocal
title Stilla - chiudi il firewall
net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo  Serve eseguire questo file come amministratore: clic destro ^> "Esegui come amministratore".
  echo.
  pause
  exit /b 1
)
netsh advfirewall firewall delete rule name="Stilla (porta 8765)"
netsh advfirewall firewall delete rule name="Ultimo Metro (porta 8765)" >nul 2>&1
echo.
pause
