# JESA Digital Twin - One-Click Launcher

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "🚀 Launching JESA Digital Twin..." -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan

# 1. Start Docker Containers (Broker, DB, Grafana, ML Inference)
Write-Host "`n[1/4] Starting Docker Infrastructure..." -ForegroundColor Yellow
docker compose up -d --build --remove-orphans

# Give Docker a few seconds to initialize
Start-Sleep -Seconds 5

# 2. Start Asset Simulators (A1, A2, A3)
Write-Host "`n[2/4] Starting OT Asset Simulators (OPC UA)..." -ForegroundColor Yellow
Start-Process -NoNewWindow -FilePath "python" -ArgumentList "-m sim all"

# Give OPC UA servers a moment to bind ports
Start-Sleep -Seconds 2

# 3. Start PLC
Write-Host "`n[3/4] Starting PLC Controller..." -ForegroundColor Yellow
Start-Process -NoNewWindow -FilePath "python" -ArgumentList "-m sim.plc"

# 4. Start UNS Gateway
Write-Host "`n[4/4] Starting UNS Gateway (OPC UA -> MQTT)..." -ForegroundColor Yellow
Start-Process -NoNewWindow -FilePath "python" -ArgumentList "-m uns"

# 5. Start 3D Digital Twin Web Server
Write-Host "`n[5/5] Starting 3D Digital Twin Web Server (Three.js)..." -ForegroundColor Yellow
Start-Process -NoNewWindow -FilePath "python" -ArgumentList "-m http.server 8000 -d web-3d"

Write-Host "`n=========================================" -ForegroundColor Green
Write-Host "✅ All systems launched successfully!" -ForegroundColor Green
Write-Host "📊 Open Grafana at: http://localhost:3000 (admin/jesa-admin)" -ForegroundColor Green
Write-Host "🌐 Open 3D Digital Twin at: http://localhost:8000" -ForegroundColor Green
Write-Host "To stop the Python processes later, run: Stop-Process -Name python" -ForegroundColor Gray
