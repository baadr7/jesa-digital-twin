# JESA Digital Twin — One-Click Launcher (PowerShell)
# Usage: Right-click → "Run with PowerShell"  or  .\launch_all.ps1

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host " JESA Digital Twin - Full Stack Launcher " -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan

# ── 1. Docker infrastructure ──────────────────────────────────────
Write-Host "`n[1/6] Starting Docker infrastructure (Mosquitto / InfluxDB / Grafana / Telegraf)..." -ForegroundColor Yellow
docker compose up -d
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] docker compose failed. Make sure Docker Desktop is running." -ForegroundColor Red
    Read-Host "Press Enter to exit"; exit 1
}

Write-Host "       Waiting 8 s for containers to become healthy..." -ForegroundColor Gray
Start-Sleep -Seconds 8

# ── 2. Asset simulators (A1 / A2 / A3) ───────────────────────────
Write-Host "`n[2/6] Starting OT asset simulators (OPC UA: A1 / A2 / A3)..." -ForegroundColor Yellow
Start-Process -FilePath "python" -ArgumentList "-m sim all" `
    -WorkingDirectory $Root -WindowStyle Normal

Write-Host "       Waiting 4 s for OPC UA servers to bind ports..." -ForegroundColor Gray
Start-Sleep -Seconds 4

# ── 3. PLC ────────────────────────────────────────────────────────
Write-Host "`n[3/6] Starting PLC controller..." -ForegroundColor Yellow
Start-Process -FilePath "python" -ArgumentList "-m sim.plc" `
    -WorkingDirectory $Root -WindowStyle Normal

# ── 4. UNS Gateway (OPC UA → MQTT) ───────────────────────────────
Write-Host "`n[4/6] Starting UNS Gateway (OPC UA -> MQTT)..." -ForegroundColor Yellow
Start-Process -FilePath "python" -ArgumentList "-m uns" `
    -WorkingDirectory $Root -WindowStyle Normal

Write-Host "       Waiting 3 s for gateway to connect..." -ForegroundColor Gray
Start-Sleep -Seconds 3

# ── 5. ML Inference service ───────────────────────────────────────
Write-Host "`n[5/6] Starting ML Inference service (A1 / A2 / A3)..." -ForegroundColor Yellow
Start-Process -FilePath "python" -ArgumentList "uns/ml_inference_service.py" `
    -WorkingDirectory $Root -WindowStyle Normal

# ── 6. 3D Digital Twin web server ────────────────────────────────
Write-Host "`n[6/6] Starting 3D Digital Twin web server on port 8000..." -ForegroundColor Yellow
Start-Process -FilePath "python" -ArgumentList "-m http.server 8000" `
    -WorkingDirectory "$Root\web-3d" -WindowStyle Normal

# ── Done ──────────────────────────────────────────────────────────
Write-Host "`n=========================================" -ForegroundColor Green
Write-Host " All systems launched!" -ForegroundColor Green
Write-Host "=========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  3D Digital Twin : http://localhost:8000" -ForegroundColor Cyan
Write-Host "  Grafana          : http://localhost:3000  (admin / jesa-admin)" -ForegroundColor Cyan
Write-Host "  InfluxDB         : http://localhost:8086  (jesa / jesa-dev-2026)" -ForegroundColor Cyan
Write-Host ""
Write-Host "Each Python service runs in its own terminal window." -ForegroundColor Gray
Write-Host "Close those windows (or run Stop-Process -Name python) to shut everything down." -ForegroundColor Gray
Write-Host ""
Read-Host "Press Enter to close this launcher"
