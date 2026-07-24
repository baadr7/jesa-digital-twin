@echo off
:: JESA Digital Twin — One-Click Launcher (CMD / BAT)
:: Double-click to run, or call from a terminal

cd /d "%~dp0"

:: Use venv Python if available, otherwise fall back to system python
set PYTHON=.venv\Scripts\python.exe
if not exist "%PYTHON%" set PYTHON=python

echo.
echo  =========================================
echo   JESA Digital Twin - Full Stack Launcher
echo  =========================================
echo   Python : %PYTHON%
echo   Root   : %CD%

:: ── 1. Docker infrastructure ────────────────────────────────────
echo.
echo [1/6] Starting Docker infrastructure (Mosquitto / InfluxDB / Grafana / Telegraf)...
docker compose up -d
if %errorlevel% neq 0 (
    echo [ERROR] docker compose failed. Is Docker Desktop running?
    pause
    exit /b 1
)

echo        Waiting 8 s for containers to become healthy...
timeout /t 8 /nobreak >nul

:: ── 2. Asset simulators (A1 / A2 / A3) ─────────────────────────
echo.
echo [2/6] Starting OT asset simulators (OPC UA: A1 / A2 / A3)...
start "JESA - Simulators" "%PYTHON%" -m sim all

echo        Waiting 4 s for OPC UA servers to bind ports...
timeout /t 4 /nobreak >nul

:: ── 3. PLC ──────────────────────────────────────────────────────
echo.
echo [3/6] Starting PLC controller...
start "JESA - PLC" "%PYTHON%" -m sim.plc

:: ── 4. UNS Gateway ──────────────────────────────────────────────
echo.
echo [4/6] Starting UNS Gateway (OPC UA ^> MQTT)...
start "JESA - UNS Gateway" "%PYTHON%" -m uns

echo        Waiting 3 s for gateway to connect...
timeout /t 3 /nobreak >nul

:: ── 5. ML Inference service ─────────────────────────────────────
echo.
echo [5/6] Starting ML Inference service (A1 / A2 / A3)...
start "JESA - ML Inference" "%PYTHON%" uns\ml_inference_service.py

:: ── 6. 3D Digital Twin web server ───────────────────────────────
echo.
echo [6/6] Starting 3D Digital Twin web server on port 8000...
start "JESA - Web Server" "%PYTHON%" -m http.server 8000 --directory web-3d

:: ── Done ────────────────────────────────────────────────────────
echo.
echo  =========================================
echo   All systems launched!
echo  =========================================
echo.
echo   3D Digital Twin : http://localhost:8000
echo   Grafana          : http://localhost:3000  (admin / jesa-admin)
echo   InfluxDB         : http://localhost:8086  (jesa / jesa-dev-2026)
echo.
echo  Each Python service runs in its own terminal window.
echo  Close those windows (or run: taskkill /f /im python.exe) to stop.
echo  =========================================
pause
