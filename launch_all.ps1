# JESA Digital Twin — One-Click Launcher (PowerShell)
# Usage: right-click -> "Run with PowerShell"  or  .\launch_all.ps1

$Root   = Split-Path -Parent $MyInvocation.MyCommand.Path
$Python = Join-Path $Root ".venv\Scripts\python.exe"

# Fallback to system python if venv not found
if (-not (Test-Path $Python)) { $Python = "python" }

Set-Location $Root

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host " JESA Digital Twin - Full Stack Launcher " -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "  Python: $Python" -ForegroundColor Gray
Write-Host "  Root  : $Root"   -ForegroundColor Gray

# ── 1. Docker infrastructure ──────────────────────────────────────
Write-Host "`n[1/6] Starting Docker infrastructure..." -ForegroundColor Yellow
docker compose up -d
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] docker compose failed. Is Docker Desktop running?" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}
Write-Host "       Waiting 8 s for containers to become healthy..." -ForegroundColor Gray
Start-Sleep -Seconds 8

# ── 2. Asset simulators (A1 / A2 / A3) ───────────────────────────
Write-Host "`n[2/6] Starting OT asset simulators (OPC UA: A1 / A2 / A3)..." -ForegroundColor Yellow
Start-Process -FilePath $Python `
    -ArgumentList @("-m", "sim", "all") `
    -WorkingDirectory $Root -WindowStyle Normal

Write-Host "       Waiting 4 s for OPC UA servers to bind ports..." -ForegroundColor Gray
Start-Sleep -Seconds 4

# ── 3. PLC ────────────────────────────────────────────────────────
Write-Host "`n[3/6] Starting PLC controller..." -ForegroundColor Yellow
Start-Process -FilePath $Python `
    -ArgumentList @("-m", "sim.plc") `
    -WorkingDirectory $Root -WindowStyle Normal

# ── 4. UNS Gateway (OPC UA → MQTT) ───────────────────────────────
Write-Host "`n[4/6] Starting UNS Gateway (OPC UA -> MQTT)..." -ForegroundColor Yellow
Start-Process -FilePath $Python `
    -ArgumentList @("-m", "uns") `
    -WorkingDirectory $Root -WindowStyle Normal

Write-Host "       Waiting 3 s for gateway to connect..." -ForegroundColor Gray
Start-Sleep -Seconds 3

# ── 5. ML Inference service ───────────────────────────────────────
Write-Host "`n[5/6] Starting ML Inference service (A1 / A2 / A3)..." -ForegroundColor Yellow
Start-Process -FilePath $Python `
    -ArgumentList @("uns\ml_inference_service.py") `
    -WorkingDirectory $Root -WindowStyle Normal

# ── 6. 3D Digital Twin web server ────────────────────────────────
Write-Host "`n[6/6] Starting 3D Digital Twin web server on port 8000..." -ForegroundColor Yellow
Start-Process -FilePath $Python `
    -ArgumentList @("-m", "http.server", "8000") `
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
Write-Host "To stop all Python processes: Stop-Process -Name python -Force" -ForegroundColor Gray
Write-Host ""
Read-Host "Press Enter to close this launcher"
