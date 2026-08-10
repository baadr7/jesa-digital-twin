# JESA Digital Twin — One-Click Launcher (PowerShell)
# Usage: right-click -> "Run with PowerShell"  or  .\launch_all.ps1
#
# Architecture:
#   HOST:   OPC UA simulators (A1/A2/A3/PLC) + UNS gateway + ML inference + 3D web server
#   DOCKER (optional): Mosquitto · Node-RED · InfluxDB · Telegraf · Grafana
#
# Demo stable mode (forces A2/A3 to healthy):
#   Edit step [3] to add "--demo-stable" to sim all arguments.

$Root   = Split-Path -Parent $MyInvocation.MyCommand.Path
$Python = Join-Path $Root ".venv\Scripts\python.exe"
if (-not (Test-Path $Python)) { $Python = "python" }

# Detect Python interpreter used for the bundled runtime (used by sim all)
$PythonRuntime = Join-Path $Root ".python\cpython-3.11.15-windows-x86_64-none\python.exe"
if (-not (Test-Path $PythonRuntime)) { $PythonRuntime = $Python }

Set-Location $Root

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host " JESA Digital Twin - Full Stack Launcher " -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "  Python  : $Python" -ForegroundColor Gray
Write-Host "  Root    : $Root"   -ForegroundColor Gray
Write-Host ""

# ── 1. Docker infrastructure (optional) ──────────────────────────
Write-Host "[1/6] Starting Docker stack (optional - skip if not available)..." -ForegroundColor Yellow
docker compose up -d 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "       Docker not available — continuing without it (Mosquitto must be running locally)." -ForegroundColor DarkYellow
} else {
    Write-Host "       Waiting 8s for containers..." -ForegroundColor Gray
    Start-Sleep -Seconds 8
}

# ── 2. OPC UA simulators (A1 / A2 / A3) ──────────────────────────
Write-Host "`n[2/6] Starting OT asset simulators (A1 / A2 / A3)..." -ForegroundColor Yellow
Write-Host "       Add --demo-stable here to force healthy A2/A3 for presentations." -ForegroundColor DarkGray
Start-Process -FilePath $Python `
    -ArgumentList @("-m", "sim", "all") `
    -WorkingDirectory $Root -WindowStyle Normal
Write-Host "       Waiting 4s for OPC UA servers to bind ports..." -ForegroundColor Gray
Start-Sleep -Seconds 4

# ── 3. PLC controller ────────────────────────────────────────────
Write-Host "`n[3/6] Starting PLC controller (port 4840)..." -ForegroundColor Yellow
Start-Process -FilePath $Python `
    -ArgumentList @("-m", "sim.plc") `
    -WorkingDirectory $Root -WindowStyle Normal
Write-Host "       Waiting 3s for PLC to connect..." -ForegroundColor Gray
Start-Sleep -Seconds 3

# ── 4. UNS Gateway ───────────────────────────────────────────────
Write-Host "`n[4/6] Starting UNS Gateway (OPC UA → MQTT)..." -ForegroundColor Yellow
Start-Process -FilePath $Python `
    -ArgumentList @("-m", "uns") `
    -WorkingDirectory $Root -WindowStyle Normal
Write-Host "       Waiting 3s for gateway to connect..." -ForegroundColor Gray
Start-Sleep -Seconds 3

# ── 5. ML Inference service ──────────────────────────────────────
Write-Host "`n[5/6] Starting ML Inference service (A1 / A2 / A3)..." -ForegroundColor Yellow
Start-Process -FilePath $Python `
    -ArgumentList @("uns\ml_inference_service.py") `
    -WorkingDirectory $Root -WindowStyle Normal
Write-Host "       Waiting 2s..." -ForegroundColor Gray
Start-Sleep -Seconds 2

# ── 6. 3D Digital Twin web server ────────────────────────────────
Write-Host "`n[6/6] Starting 3D Digital Twin web server on port 8000..." -ForegroundColor Yellow
Start-Process -FilePath $Python `
    -ArgumentList @("-m", "http.server", "8000", "--bind", "0.0.0.0", "--directory", "$Root\web-3d") `
    -WorkingDirectory $Root -WindowStyle Normal

# ── Done ──────────────────────────────────────────────────────────
Write-Host "`n=========================================" -ForegroundColor Green
Write-Host " All systems launched!" -ForegroundColor Green
Write-Host "=========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  3D Digital Twin    : http://localhost:8000" -ForegroundColor Cyan
Write-Host "  Grafana            : http://localhost:3000  (admin / jesa-admin)"   -ForegroundColor Cyan
Write-Host "  InfluxDB           : http://localhost:8086  (jesa / jesa-dev-2026)" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Host processes  : OPC UA sims · PLC · UNS gateway · ML inference · http.server :8000" -ForegroundColor Green
Write-Host ""
Write-Host "  Stop all : Stop-Process -Name python -Force" -ForegroundColor Gray
Write-Host "  Docker   : docker compose down"              -ForegroundColor Gray
Write-Host ""
Read-Host "Press Enter to close this launcher"
