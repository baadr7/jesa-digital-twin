# JESA Digital Twin — One-Click Launcher (PowerShell)
# Usage: right-click -> "Run with PowerShell"  or  .\launch_all.ps1
#
# Gateway strategy:
#   Python uns/gateway.py is the PRIMARY OPC UA → MQTT gateway.
#   Node-RED Docker is DISABLED — crashes on WSL2 kernel (Node.js JIT trap).
#   Derived data (power_kw, cooler_delta_t, comp_duty) is computed inside
#   gateway.py via DerivedPublisher (replicates Node-RED Tab 02 logic).
#
# Demo stable mode: add "--demo-stable" to sim all arguments (step 2).

$Root   = Split-Path -Parent $MyInvocation.MyCommand.Path
$Python = Join-Path $Root ".venv\Scripts\python.exe"
if (-not (Test-Path $Python)) { $Python = "python" }

Set-Location $Root

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host " JESA Digital Twin - Full Stack Launcher " -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "  Python  : $Python" -ForegroundColor Gray
Write-Host "  Root    : $Root"   -ForegroundColor Gray
Write-Host ""

# ── 1. Docker stack (Mosquitto · InfluxDB · Telegraf · Grafana) ──
Write-Host "[1/6] Starting Docker stack (Mosquitto, InfluxDB, Grafana)..." -ForegroundColor Yellow
Write-Host "       Note: Node-RED is excluded (WSL2 Node.js crash)" -ForegroundColor DarkGray
docker compose up -d mosquitto influxdb telegraf grafana 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "  [WARN] docker compose partial — continuing anyway." -ForegroundColor DarkYellow
}
Write-Host "       Waiting 8s for Mosquitto to be ready..." -ForegroundColor Gray
Start-Sleep -Seconds 8

# ── 2. OPC UA simulators (A1 / A2 / A3) ─────────────────────────
Write-Host "`n[2/6] Starting OT asset simulators (A1 / A2 / A3)..." -ForegroundColor Yellow
Write-Host "       Add --demo-stable here to force healthy A2/A3." -ForegroundColor DarkGray
Start-Process -FilePath $Python `
    -ArgumentList @("-m", "sim", "all") `
    -WorkingDirectory $Root -WindowStyle Normal
Write-Host "       Waiting 5s for OPC UA servers to bind ports..." -ForegroundColor Gray
Start-Sleep -Seconds 5

# ── 3. PLC controller ────────────────────────────────────────────
Write-Host "`n[3/6] Starting PLC controller (port 4840)..." -ForegroundColor Yellow
Start-Process -FilePath $Python `
    -ArgumentList @("-m", "sim.plc") `
    -WorkingDirectory $Root -WindowStyle Normal
Write-Host "       Waiting 3s..." -ForegroundColor Gray
Start-Sleep -Seconds 3

# ── 4. UNS Gateway (OPC UA → MQTT + derived data engine) ─────────
Write-Host "`n[4/6] Starting Python UNS Gateway (OPC UA → MQTT + derived KPIs)..." -ForegroundColor Yellow
Start-Process -FilePath $Python `
    -ArgumentList @("-m", "uns") `
    -WorkingDirectory $Root -WindowStyle Normal
Write-Host "       Waiting 4s for gateway to connect to OPC UA..." -ForegroundColor Gray
Start-Sleep -Seconds 4

# ── 5. ML Inference service ───────────────────────────────────────
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
Write-Host "  3D Digital Twin : http://localhost:8000" -ForegroundColor Cyan
Write-Host "  Grafana         : http://localhost:3000  (admin / jesa-admin)" -ForegroundColor Cyan
Write-Host "  InfluxDB        : http://localhost:8086  (jesa / jesa-dev-2026)" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Host processes  : sim(A1/A2/A3) · PLC · uns-gateway · ML · http:8000" -ForegroundColor Green
Write-Host "  Docker services : Mosquitto · InfluxDB · Telegraf · Grafana" -ForegroundColor Green
Write-Host ""
Write-Host "  Stop Python : Stop-Process -Name python -Force" -ForegroundColor Gray
Write-Host "  Stop Docker : docker compose down" -ForegroundColor Gray
Write-Host ""
Read-Host "Press Enter to close this launcher"
