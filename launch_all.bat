@echo off
echo =========================================
echo Launching JESA Digital Twin...
echo =========================================

echo.
echo [1/4] Starting Docker Infrastructure...
docker compose up -d

echo.
echo Waiting 5 seconds for Docker to initialize...
timeout /t 5 /nobreak >nul

echo.
echo [2/4] Starting OT Asset Simulators (OPC UA)...
start "JESA - Asset Simulators" python -m sim all

echo.
echo Waiting 2 seconds for OPC UA servers to bind ports...
timeout /t 2 /nobreak >nul

echo.
echo [3/4] Starting PLC Controller...
start "JESA - PLC Controller" python -m sim.plc

echo.
echo [4/4] Starting UNS Gateway (OPC UA -^> MQTT)...
start "JESA - UNS Gateway" python -m uns

:: 5. Start 3D Digital Twin Web Server
echo.
echo [5/5] Starting 3D Digital Twin Web Server (Three.js)...
start /b cmd /c "python -m http.server 8000 -d web-3d"

echo.
echo =========================================
echo [OK] All systems launched successfully!
echo [INFO] Open Grafana at: http://localhost:3000 (admin/jesa-admin)
echo.
echo =========================================
echo [OK] All systems launched successfully!
echo [INFO] Open Grafana at: http://localhost:3000 (admin/jesa-admin)
echo [INFO] Open 3D Digital Twin at: http://localhost:8000
echo.
echo Note: Background terminal windows have been opened for the simulators, PLC, and gateway.
echo Close them to stop the digital twin.
echo =========================================
pause
