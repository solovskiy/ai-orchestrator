# Готовит окружение для MCP browser-bot (Real Browser MCP, порт 9333):
# освобождает порт и поднимает изолированный Chrome-профиль бота.
# MCP-сервер (npx real-browser-mcp) поднимает сам opencode — он
# зарегистрирован глобально в ~/.config/opencode/opencode.json.
# Использование: powershell -ExecutionPolicy Bypass -File browser-preflight.ps1

$port = 9333
$profilePath = "$env:USERPROFILE\.config\chrome-bot-profile"

Write-Host "[1/2] Freeing port $port..." -ForegroundColor Yellow
$conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
foreach ($c in $conns) {
    Write-Host "  Killing PID $($c.OwningProcess)" -ForegroundColor Gray
    Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
}
if ($conns) { Start-Sleep -Seconds 2 }
Write-Host "  Port $port is free" -ForegroundColor Green

Write-Host "[2/2] Launching Chrome Bot Profile..." -ForegroundColor Yellow
$running = Get-Process -Name "chrome" -ErrorAction SilentlyContinue | Where-Object {
    try { (Get-CimInstance Win32_Process -Filter "ProcessId = $($_.Id)").CommandLine -match "chrome-bot-profile" }
    catch { $false }
}
if (-not $running) {
    if (-not (Test-Path $profilePath)) { New-Item -ItemType Directory -Path $profilePath -Force | Out-Null }
    Start-Process "chrome" -ArgumentList @(
        "--user-data-dir=$profilePath",
        "--no-first-run",
        "--no-default-browser-check"
    )
    Write-Host "  Chrome Bot Profile launched" -ForegroundColor Green
} else {
    Write-Host "  Chrome Bot Profile already running" -ForegroundColor Green
}

Write-Host ""
Write-Host "Готово. Дай расширению Real Browser MCP 10-15 сек на переподключение" -ForegroundColor Cyan
Write-Host "(экспоненциальный backoff), затем повтори вызов browser-bot_* инструмента." -ForegroundColor Cyan
