# Courtesy Antigravity Codex Desktop Launcher
Write-Host ">>> Launching Courtesy Antigravity Codex Desktop GUI..." -ForegroundColor Cyan

# Check node_modules
if (-not (Test-Path ".\node_modules\electron")) {
    Write-Host "Installing Electron dependencies..." -ForegroundColor Yellow
    npm install
}

Write-Host "Connected to Courtesy Gateway (100.107.249.92:8000)..." -ForegroundColor Green
npx electron .
