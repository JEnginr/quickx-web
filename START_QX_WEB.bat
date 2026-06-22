@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

REM ============================================================
REM  QuickX Web 1.10 Beta v0.6 — One-click LAN host
REM
REM  Normal use: double-click this file.
REM  First run only: it will request Administrator approval,
REM  install the URL reservation + LocalSubnet firewall rule,
REM  then start QX Web. Later runs start normally.
REM ============================================================

set "QX_PORT=8080"
set "QX_PREFIX=http://+:%QX_PORT%/"
set "QX_RULE=QuickX Web %QX_PORT%"
set "QX_SCRIPT=%~dp0qx-web-server.ps1"
set "QX_LOG=%~dp0QX_WEB_STARTUP.log"

if not exist "%QX_SCRIPT%" (
  echo.
  echo ERROR: qx-web-server.ps1 was not found beside this BAT file.
  echo Folder: %~dp0
  pause
  exit /b 2
)

REM ------------------------------------------------------------
REM Check whether the one-time LAN prerequisites already exist.
REM ------------------------------------------------------------
call :CHECK_SETUP
if "%QX_SETUP_OK%"=="1" goto CHECK_PORT

REM Setup is missing. Ask for elevation automatically; the user
REM does NOT need to run a separate installer BAT.
if /I "%~1"=="--qx-install" goto INSTALL_AS_ADMIN

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "Start-Process -FilePath $env:ComSpec -ArgumentList '/d /c ""%~f0" --qx-install"' -WorkingDirectory '%~dp0' -Verb RunAs"
if errorlevel 1 (
  echo.
  echo ERROR: Administrator approval was cancelled or could not start.
  pause
)
exit /b

:INSTALL_AS_ADMIN
fltmc >nul 2>&1
if errorlevel 1 (
  echo.
  echo ERROR: Administrator rights are required for the first-time LAN setup.
  pause
  exit /b 5
)

echo.
echo ============================================================
echo  QuickX Web — first-time LAN setup
echo ============================================================
echo.

REM Remove a stale reservation for this exact prefix, then reserve it
REM for the current Windows user. This is safe and does not touch any
REM other URL or application.
netsh http delete urlacl url=%QX_PREFIX% >nul 2>&1
netsh http add urlacl url=%QX_PREFIX% user="%USERDOMAIN%\%USERNAME%" listen=yes >nul
if errorlevel 1 (
  echo ERROR: Could not reserve %QX_PREFIX%
  echo See %QX_LOG% for details.
  netsh http add urlacl url=%QX_PREFIX% user="%USERDOMAIN%\%USERNAME%" listen=yes >>"%QX_LOG%" 2>&1
  pause
  exit /b 6
)

REM Recreate one clear firewall rule. Scope it to LocalSubnet so the
REM port is available to Quickmill LAN devices, not arbitrary remote IPs.
netsh advfirewall firewall delete rule name="%QX_RULE%" >nul 2>&1
netsh advfirewall firewall add rule ^
  name="%QX_RULE%" ^
  dir=in action=allow protocol=TCP localport=%QX_PORT% ^
  profile=domain,private remoteip=LocalSubnet enable=yes >nul
if errorlevel 1 (
  echo ERROR: Could not create the Windows Firewall rule for port %QX_PORT%.
  echo See %QX_LOG% for details.
  netsh advfirewall firewall add rule name="%QX_RULE%" dir=in action=allow protocol=TCP localport=%QX_PORT% profile=domain,private remoteip=LocalSubnet enable=yes >>"%QX_LOG%" 2>&1
  pause
  exit /b 7
)

echo URL reservation installed: %QX_PREFIX%
echo Firewall rule installed:  %QX_RULE% ^(Quickmill LocalSubnet only^)
echo.
echo Starting QuickX Web now...
echo.
goto CHECK_PORT

:CHECK_PORT
REM ------------------------------------------------------------
REM Prevent a confusing failure when another program already owns 8080.
REM If QX is already healthy, show the link and do not start a duplicate.
REM ------------------------------------------------------------
set "QX_HEALTHY=0"
for /f "usebackq delims=" %%H in (`powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try { $r=Invoke-RestMethod -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:%QX_PORT%/api/health'; if($r.ok){'1'} } catch {}"`) do set "QX_HEALTHY=%%H"
if "%QX_HEALTHY%"=="1" (
  call :SHOW_LINKS
  echo QuickX Web is already running. No second server was started.
  echo.
  pause
  exit /b 0
)

set "QX_PORT_PID="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":%QX_PORT% .*LISTENING"') do if not defined QX_PORT_PID set "QX_PORT_PID=%%P"
if defined QX_PORT_PID (
  echo.
  echo ERROR: Port %QX_PORT% is already being used by process ID !QX_PORT_PID!,
  echo but it is not responding as QuickX Web.
  echo Close that program or change the QX port before starting.
  echo.
  tasklist /FI "PID eq !QX_PORT_PID!"
  pause
  exit /b 8
)

:RUN_SERVER
call :SHOW_LINKS

echo Starting QuickX Web...
echo Keep this window open while users are using QX.
echo Press Ctrl+C to stop the server.
echo.

REM Write the command/start time to a local diagnostic log while keeping
REM the normal live server output visible in this window.
>>"%QX_LOG%" echo ============================================================
>>"%QX_LOG%" echo [%date% %time%] Starting QX Web on %QX_PREFIX%

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%QX_SCRIPT%" -Prefix "%QX_PREFIX%"
set "QX_EXIT=%ERRORLEVEL%"

echo.
if not "%QX_EXIT%"=="0" (
  echo QuickX Web stopped with error code %QX_EXIT%.
  echo Check the messages above and: %QX_LOG%
) else (
  echo QuickX Web stopped normally.
)
pause
exit /b %QX_EXIT%

:CHECK_SETUP
set "QX_URL_OK=0"
set "QX_FW_OK=0"
netsh http show urlacl url=%QX_PREFIX% 2>nul | findstr /I /C:"%QX_PREFIX%" >nul && set "QX_URL_OK=1"
netsh advfirewall firewall show rule name="%QX_RULE%" 2>nul | findstr /I /C:"Rule Name:" >nul && set "QX_FW_OK=1"
if "%QX_URL_OK%"=="1" if "%QX_FW_OK%"=="1" (
  set "QX_SETUP_OK=1"
) else (
  set "QX_SETUP_OK=0"
)
exit /b 0

:SHOW_LINKS
set "QX_IP="
for /f "usebackq delims=" %%I in (`powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ip=Get-NetIPAddress -AddressFamily IPv4 -AddressState Preferred -ErrorAction SilentlyContinue ^| Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.InterfaceAlias -notmatch 'Loopback|Bluetooth|Virtual|VMware|vEthernet' } ^| Sort-Object InterfaceMetric ^| Select-Object -First 1 -ExpandProperty IPAddress; if($ip){$ip}"`) do set "QX_IP=%%I"
if not defined QX_IP set "QX_IP=THIS-PC-IP"
echo ============================================================
echo  QuickX Web LAN address
echo ============================================================
echo  This PC:  http://127.0.0.1:%QX_PORT%/
echo  Other PCs: http://%QX_IP%:%QX_PORT%/
echo  Health:    http://%QX_IP%:%QX_PORT%/api/health
echo ============================================================
echo.
exit /b 0
