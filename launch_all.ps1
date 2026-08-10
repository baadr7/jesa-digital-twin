# JESA Digital Twin — One-Click Launcher (PowerShell)
# Usage: right-click -> "Run with PowerShell"  or  .\launch_all.ps1
#
# Architecture:
#   HOST:   OPC UA simulators (A1/A2/A3/PLC) + 3D web server
#   DOCKER: Mosquitto · Node-RED · InfluxDB · Telegraf · Grafana · ML-Inference
#
# Node-RED in Docker connects to OPC UA sims via host.docker.internal:4840-4843.
#
# Demo stable mode (forces A2/A3 to healthy):
#   Edit step [2] to add "--demo-stable" to sim all arguments.

$Root   = Split-Path -Parent $MyInvocation.MyCommand.Path
$Python = Join-Path $Root ".venv\Scripts\python.exe"
if (-not (Test-Path $Python)) { $Python = "python" }

Set-Location $Root

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host " JESA Digital Twin - Full Stack Launcher " -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "  Python : $Python" -ForegroundColor Gray
Write-Host "  Root   : $Root"   -ForegroundColor Gray
Write-Host "  Docker : Mosquitto · Node-RED · InfluxDB · Telegraf · Grafana · ML" -ForegroundColor Green
Write-Host "  Host   : OPC UA sims (A1/A2/A3/PLC) · 3D web server" -ForegroundColor Green
Write-Host ""

# ── 1. Docker infrastructure ──────────────────────────────────────
Write-Host "[1/4] Starting Docker stack (Mosquitto / Node-RED / InfluxDB / Telegraf / Grafana / ML)..." -ForegroundColor Yellow
docker compose up -d
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] docker compose failed. Is Docker Desktop running?" -ForegroundColor Red
    Read-Host "Press Enter to exit"; exit 1
}
Write-Host "       Waiting 10s for containers to become healthy..." -ForegroundColor Gray
Start-Sleep -Seconds 10

# ── 2. OPC UA simulators (A1 / A2 / A3) ──────────────────────────
Write-Host "`n[2/4] Starting OT asset simulators (A1 / A2 / A3)..." -ForegroundColor Yellow
Write-Host "       Add --demo-stable here to force healthy A2/A3 for presentations." -ForegroundColor DarkGray
Start-Process -FilePath $Python `
    -ArgumentList @("-m", "sim", "all") `
    -WorkingDirectory $Root -WindowStyle Normal
Write-Host "       Waiting 4s for OPC UA servers to bind ports..." -ForegroundColor Gray
Start-Sleep -Seconds 4

# ── 3. PLC controller ────────────────────────────────────────────
Write-Host "`n[3/4] Starting PLC controller (port 4840)..." -ForegroundColor Yellow
Start-Process -FilePath $Python `
    -ArgumentList @("-m", "sim.plc") `
    -WorkingDirectory $Root -WindowStyle Normal
Write-Host "       Waiting 3s for PLC to connect..." -ForegroundColor Gray
Start-Sleep -Seconds 3

# ── 4. 3D Digital Twin web server ────────────────────────────────
Write-Host "`n[4/4] Starting 3D Digital Twin web server on port 8000..." -ForegroundColor Yellow
Start-Process -FilePath $Python `
    -ArgumentList @("-m", "http.server", "8000") `
    -WorkingDirectory "$Root\web-3d" -WindowStyle Normal

# ── Done ──────────────────────────────────────────────────────────
Write-Host "`n=========================================" -ForegroundColor Green
Write-Host " All systems launched!" -ForegroundColor Green
Write-Host "=========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  3D Digital Twin    : http://localhost:8000" -ForegroundColor Cyan
Write-Host "  Node-RED editor    : http://localhost:1880        (OPC UA gateway + alarms)" -ForegroundColor Cyan
Write-Host "  Node-RED dashboard : http://localhost:1880/ui     (system monitor)"           -ForegroundColor Cyan
Write-Host "  Grafana            : http://localhost:3000          (admin / jesa-admin)"   -ForegroundColor Cyan
Write-Host "  InfluxDB           : http://localhost:8086          (jesa / jesa-dev-2026)" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Docker services : Mosquitto · Node-RED · InfluxDB · Telegraf · Grafana · ML" -ForegroundColor Green
Write-Host "  Host processes  : OPC UA sims (A1/A2/A3/PLC) · http.server :8000" -ForegroundColor Green
Write-Host ""
Write-Host "  Stop Python : Stop-Process -Name python -Force" -ForegroundColor Gray
Write-Host "  Stop Docker : docker compose down"              -ForegroundColor Gray
Write-Host ""
Read-Host "Press Enter to close this launcher"
