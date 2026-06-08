# AI Brain — Quick Start Script
# Usage: .\start.ps1

Write-Host "═══════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  AI Brain Gateway — Quick Start" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════" -ForegroundColor Cyan

# Stop old services
Write-Host "`n[1/4] Stopping old services..." -ForegroundColor Yellow
pm2 stop all 2>$null
pm2 delete all 2>$null
Start-Sleep -Seconds 2

# Check Redis
Write-Host "`n[2/4] Checking Redis..." -ForegroundColor Yellow
try {
    $redis = New-Object System.Net.Sockets.TcpClient
    $redis.Connect("127.0.0.1", 6379)
    $redis.Close()
    Write-Host "  Redis: OK ✅" -ForegroundColor Green
} catch {
    Write-Host "  Redis: NOT RUNNING ❌" -ForegroundColor Red
    Write-Host "  Start Redis first: docker-compose up -d redis" -ForegroundColor Yellow
}

# Check .env
Write-Host "`n[3/4] Checking .env..." -ForegroundColor Yellow
if (Test-Path ".env") {
    $envContent = Get-Content ".env" -Raw
    $hasToken = $envContent -match "DISCORD_BOT_TOKEN\s*=\s*\S+"
    $hasApiKey = $envContent -match "OPENROUTER_API_KEY\s*=\s*\S+"
    Write-Host "  .env: EXISTS ✅" -ForegroundColor Green
    Write-Host "  DISCORD_BOT_TOKEN: $(if($hasToken){'SET ✅'}else{'MISSING ❌'})" -ForegroundColor $(if($hasToken){"Green"}else{"Red"})
    Write-Host "  OPENROUTER_API_KEY: $(if($hasApiKey){'SET ✅'}else{'MISSING ❌'})" -ForegroundColor $(if($hasApiKey){"Green"}else{"Red"})
} else {
    Write-Host "  .env: MISSING ❌" -ForegroundColor Red
}

# Start all
Write-Host "`n[4/4] Starting all services..." -ForegroundColor Yellow
pm2 start ecosystem.config.cjs
Start-Sleep -Seconds 3

Write-Host "`n═══════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  Status:" -ForegroundColor Cyan
pm2 list
Write-Host "═══════════════════════════════════════════" -ForegroundColor Cyan

Write-Host "`nHealth check: http://localhost:3000/health" -ForegroundColor Green
Write-Host "REST API:     http://localhost:3005" -ForegroundColor Green
Write-Host "Feedback:     http://localhost:4002" -ForegroundColor Green
Write-Host "`nLogs: pm2 logs" -ForegroundColor Gray
Write-Host "Stop:  pm2 stop all" -ForegroundColor Gray
