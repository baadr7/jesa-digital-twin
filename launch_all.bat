@echo off
:: JESA Digital Twin — One-Click Launcher (CMD / BAT)
:: Double-click to run, or call from a terminal

cd /d "%~dp0"

echo.
echo  =========================================
echo   JESA Digital Twin - Full Stack Launcher
echo  =========================================

:: ── 1. Docker infrastructure ────────────────────────────────────
echo.
echo [1/6] Starting Docker infrastructure (Mosquitto / InfluxDB / Grafana / Telegraf)...
docker compose up -d
if %errorlevel% neq 0 (
    echo [ERROR] docker compose failed. Make sure Docker Desktop is running.
    pause
    exit /b 1
)

echo.
echo        Waiting 8 s for containers to become healthy...
timeout /t 8 /nobreak >nul

:: ── 2. Asset simulators (A1 / A2 / A3) ─────────────────────────
echo.
echo [2/6] Starting OT asset simulators (OPC UA: A1 / A2 / A3)...
start "JESA - Simulators" python -m sim all

echo        Waiting 4 s for OPC UA servers to bind ports...
timeout /t 4 /nobreak >nul

:: ── 3. PLC ──────────────────────────────────────────────────────
echo.
echo [3/6] Starting PLC controller...
start "JESA - PLC" python -m sim.plc

:: ── 4. UNS Gateway ──────────────────────────────────────────────
echo.
echo [4/6] Starting UNS Gateway (OPC UA ^> MQTT)...
start "JESA - UNS Gateway" python -m uns

echo        Waiting 3 s for gateway to connect...
timeout /t 3 /nobreak >nul

:: ── 5. ML Inference service ─────────────────────────────────────
echo.
echo [5/6] Starting ML Inference service (A1 / A2 / A3)...
start "JESA - ML Inference" python uns/ml_inference_service.py

:: ── 6. 3D Digital Twin web server ───────────────────────────────
echo.
echo [6/6] Starting 3D Digital Twin web server on port 8000...
start "JESA - Web Server" cmd /c "cd web-3d && python -m http.server 8000"

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
echo  Close those windows to shut down the digital twin.
echo  =========================================
pause
