@echo off
:: JESA Digital Twin — One-Click Launcher (CMD / BAT)
:: Double-click to run, or call from a terminal
::
:: UNS Gateway strategy:
::   Python uns/gateway.py = PRIMARY OPC UA -> MQTT bridge (A1/A2/A3/PLC)
::   Node-RED (Docker)      = Derived data + ISA-18.2 Alarm Engine + Monitor only
::                            (OPC UA Gateway tab is DISABLED in flows.json)
::
:: Demo stable mode: change step [2] to add --demo-stable to sim all

cd /d "%~dp0"

set PYTHON=.venv\Scripts\python.exe
if not exist "%PYTHON%" set PYTHON=python

echo.
echo  =========================================
echo   JESA Digital Twin - Full Stack Launcher
echo  =========================================
echo   Python  : %PYTHON%
echo   Root    : %CD%
echo   Gateway : Python uns/gateway.py  ^(OPC UA->MQTT, primary^)
echo   Node-RED: Derived data + Alarms + Monitor  ^(Docker, OPC UA tab disabled^)

:: ── 1. Docker infrastructure ──────────────────────────────────────
echo.
echo [1/6] Starting Docker (Mosquitto / Node-RED / InfluxDB / Telegraf / Grafana)...
docker compose up -d mosquitto nodered influxdb telegraf grafana
if %errorlevel% neq 0 (
    echo [ERROR] docker compose failed. Is Docker Desktop running?
    pause & exit /b 1
)
echo        Waiting 10s for containers to become healthy...
echo        (Node-RED loads derived-data + alarm flows only)
timeout /t 10 /nobreak >nul

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

:: ── 4. UNS Gateway — Python (primary OPC UA -> MQTT) ─────────────
echo.
echo [4/6] Starting Python UNS Gateway ^(OPC UA -> MQTT, 1 Hz^)...
echo        Bridges A1/A2/A3/PLC telemetry to jesa/site1/# topics.
start "JESA - UNS Gateway" "%PYTHON%" -m uns
echo        Waiting 3s for gateway to connect OPC UA + MQTT...
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
echo   Node-RED editor    : http://localhost:1880   ^(derived data + alarms only^)
echo   Node-RED dashboard : http://localhost:1880/ui ^(system monitor^)
echo   UNS gateway        : Python uns/gateway.py ^[OPC UA->MQTT, primary^]
echo   Grafana            : http://localhost:3000   ^(admin / jesa-admin^)
echo   InfluxDB           : http://localhost:8086   ^(jesa / jesa-dev-2026^)
echo.
pause
