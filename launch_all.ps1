# JESA Digital Twin — One-Click Launcher (PowerShell)
# Usage: right-click -> "Run with PowerShell"  or  .\launch_all.ps1
#
# Gateway strategy:
#   Node-RED Docker is the PRIMARY OPC UA → MQTT gateway (Tab 01).
#   Derived data + ISA-18.2 Alarm Engine are handled inside Node-RED (Tabs 02/03).
#   Python uns/gateway.py is DISABLED — Node-RED replaces it entirely.
#
# Demo stable mode: add "--demo-stable" to sim all arguments (step 2).

$Root   = Split-Path -Parent $MyInvocation.MyCommand.Path
$Python = Join-Path $Root ".venv\Scripts\python.exe"
if (-not (Test-Path $Python)) { $Python = "python" }

Set-Location $Root

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host " JESA Digital Twin - Full Stack Launcher " -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "  Gateway : Node-RED (Docker)" -ForegroundColor Gray
Write-Host "  Python  : $Python" -ForegroundColor Gray
Write-Host "  Root    : $Root"   -ForegroundColor Gray
Write-Host ""

# ── 1. Docker stack (Mosquitto · Node-RED · InfluxDB · Telegraf · Grafana) ──
Write-Host "[1/5] Starting Docker stack (Mosquitto, Node-RED, InfluxDB, Telegraf, Grafana)..." -ForegroundColor Yellow
docker compose up -d mosquitto nodered influxdb telegraf grafana 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "  [WARN] docker compose partial — continuing anyway." -ForegroundColor DarkYellow
}
Write-Host "       Waiting 15s for Mosquitto + Node-RED to initialise..." -ForegroundColor Gray
Write-Host "       (Node-RED first-boot installs OPC UA nodes, can take 45-60s)" -ForegroundColor DarkGray
Start-Sleep -Seconds 15

# ── 2. OPC UA simulators (A1 / A2 / A3) ─────────────────────────
Write-Host "`n[2/5] Starting OT asset simulators (A1 / A2 / A3)..." -ForegroundColor Yellow
Write-Host "       Add --demo-stable here to force healthy A2/A3." -ForegroundColor DarkGray
Start-Process -FilePath $Python `
    -ArgumentList @("-m", "sim", "all") `
    -WorkingDirectory $Root -WindowStyle Normal
Write-Host "       Waiting 5s for OPC UA servers to bind ports..." -ForegroundColor Gray
Start-Sleep -Seconds 5

# ── 3. PLC controller ────────────────────────────────────────────
Write-Host "`n[3/5] Starting PLC controller (port 4840)..." -ForegroundColor Yellow
Start-Process -FilePath $Python `
    -ArgumentList @("-m", "sim.plc") `
    -WorkingDirectory $Root -WindowStyle Normal
Write-Host "       Waiting 3s..." -ForegroundColor Gray
Start-Sleep -Seconds 3

# ── 4. ML Inference service ───────────────────────────────────────
Write-Host "`n[4/5] Starting ML Inference service (A1 / A2 / A3)..." -ForegroundColor Yellow
Start-Process -FilePath $Python `
    -ArgumentList @("uns\ml_inference_service.py") `
    -WorkingDirectory $Root -WindowStyle Normal
Write-Host "       Waiting 2s..." -ForegroundColor Gray
Start-Sleep -Seconds 2

# ── 5. 3D Digital Twin web server ────────────────────────────────
Write-Host "`n[5/5] Starting 3D Digital Twin web server on port 8000..." -ForegroundColor Yellow
Start-Process -FilePath $Python `
    -ArgumentList @("-m", "http.server", "8000", "--bind", "0.0.0.0", "--directory", "$Root\web-3d") `
    -WorkingDirectory $Root -WindowStyle Normal

# ── Done ──────────────────────────────────────────────────────────
Write-Host "`n=========================================" -ForegroundColor Green
Write-Host " All systems launched!" -ForegroundColor Green
Write-Host "=========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Node-RED Editor : http://localhost:1880   (UNS Gateway)" -ForegroundColor Cyan
Write-Host "  Node-RED Dashboard: http://localhost:1880/ui (Monitor)" -ForegroundColor Cyan
Write-Host "  3D Digital Twin : http://localhost:8000" -ForegroundColor Cyan
Write-Host "  Grafana         : http://localhost:3000  (admin / jesa-admin)" -ForegroundColor Cyan
Write-Host "  InfluxDB        : http://localhost:8086  (jesa / jesa-dev-2026)" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Host processes  : sim(A1/A2/A3) · PLC · ML · http:8000" -ForegroundColor Green
Write-Host "  Docker services : Mosquitto · Node-RED · InfluxDB · Telegraf · Grafana" -ForegroundColor Green
Write-Host ""
Write-Host "  Gateway         : Node-RED handles OPC UA → MQTT + Derived KPIs + Alarms" -ForegroundColor Green
Write-Host ""
Write-Host "  Stop Python : Stop-Process -Name python -Force" -ForegroundColor Gray
Write-Host "  Stop Docker : docker compose down" -ForegroundColor Gray
Write-Host ""
Read-Host "Press Enter to close this launcher"
