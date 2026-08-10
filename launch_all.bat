@echo off
:: JESA Digital Twin — One-Click Launcher (CMD / BAT)
:: Double-click to run, or call from a terminal
::
:: UNS Gateway strategy (auto-detected):
::   Node-RED present  → Node-RED primary (OPC UA→MQTT + derived data + alarms)
::   Node-RED absent   → Python uns/gateway.py fallback (OPC UA→MQTT only)
::
:: Demo stable mode: change step [2] to add --demo-stable to sim all

cd /d "%~dp0"

set PYTHON=.venv\Scripts\python.exe
if not exist "%PYTHON%" set PYTHON=python

:: Detect Node-RED installation
set NODERED_ENTRY=nodered-runtime\node_modules\node-red\red.js
set NODERED_USER=%CD%\nodered-runtime\userdir
set NODERED_CFG=%CD%\nodered-runtime\userdir\settings.js
set USE_NODERED=0
if exist "%NODERED_ENTRY%" set USE_NODERED=1

echo.
echo  =========================================
echo   JESA Digital Twin - Full Stack Launcher
echo  =========================================
echo   Python  : %PYTHON%
echo   Root    : %CD%
if "%USE_NODERED%"=="1" (
    echo   Gateway : Node-RED PRIMARY  ^(OPC UA->MQTT + derived + alarms^)
) else (
    echo   Gateway : Python FALLBACK  ^(OPC UA->MQTT only^)
)

:: ── 1. Docker infrastructure ──────────────────────────────────────
echo.
echo [1/6] Starting Docker (Mosquitto / InfluxDB / Telegraf / Grafana)...
docker compose up -d
if %errorlevel% neq 0 (
    echo [ERROR] docker compose failed. Is Docker Desktop running?
    pause & exit /b 1
)
echo        Waiting 8s for containers to become healthy...
timeout /t 8 /nobreak >nul

:: ── 2. OPC UA simulators (A1 / A2 / A3) ──────────────────────────
echo.
echo [2/6] Starting OT asset simulators (A1 / A2 / A3)...
echo        Add --demo-stable for forced-healthy demo mode.
start "JESA - Simulators" "%PYTHON%" -m sim all
echo        Waiting 4s for OPC UA ports to bind...
timeout /t 4 /nobreak >nul

:: ── 3. PLC controller ─────────────────────────────────────────────
echo.
echo [3/6] Starting PLC controller (port 4840)...
start "JESA - PLC" "%PYTHON%" -m sim.plc
echo        Waiting 3s for PLC to connect...
timeout /t 3 /nobreak >nul

:: ── 4. UNS Gateway — Node-RED (primary) or Python (fallback) ─────
echo.
if "%USE_NODERED%"=="1" (
    echo [4/6] Starting Node-RED UNS Gateway on port 1880...
    echo        OPC UA Gateway + Derived Data + Alarm Engine + Monitor
    set NODE_RED_USER_DIR=%NODERED_USER%
    start "JESA - Node-RED" node "%NODERED_ENTRY%" --userDir "%NODERED_USER%" --settings "%NODERED_CFG%"
    echo        Node-RED starting... allow ~10s then open http://localhost:1880
    echo        NOTE: uns/gateway.py NOT started - Node-RED is the UNS gateway.
) else (
    echo [4/6] Node-RED not found - starting Python UNS gateway ^(fallback^)...
    echo        WARNING: No derived data or alarm engine in fallback mode.
    start "JESA - UNS Gateway" "%PYTHON%" -m uns
    echo        To install Node-RED: cd nodered-runtime ^&^& npm install node-red@4.0.9 node-red-contrib-opcua@0.2.354 node-red-dashboard@3.6.5
)
echo        Waiting 3s for gateway to connect...
timeout /t 3 /nobreak >nul

:: ── 5. ML Inference (local Python) ────────────────────────────────
echo.
echo [5/6] Starting ML Inference service (A1 / A2 / A3)...
start "JESA - ML Inference" "%PYTHON%" uns\ml_inference_service.py

:: ── 6. 3D Digital Twin web server ─────────────────────────────────
echo.
echo [6/6] Starting 3D Digital Twin web server on port 8000...
start "JESA - Web Server" "%PYTHON%" -m http.server 8000 --directory web-3d

:: ── Done ──────────────────────────────────────────────────────────
echo.
echo  =========================================
echo   All systems launched!
echo  =========================================
echo.
echo   3D Digital Twin    : http://localhost:8000
if "%USE_NODERED%"=="1" (
    echo   Node-RED editor    : http://localhost:1880   ^(UNS gateway + alarms^)
    echo   Node-RED dashboard : http://localhost:1880/ui ^(system monitor^)
    echo   UNS gateway : Node-RED [OPC UA->MQTT + derived data + HH/H/L/LL alarms]
) else (
    echo   UNS gateway : Python uns/gateway.py [OPC UA->MQTT only - fallback]
)
echo   Grafana            : http://localhost:3000   ^(admin / jesa-admin^)
echo   InfluxDB           : http://localhost:8086   ^(jesa / jesa-dev-2026^)
echo.
pause
