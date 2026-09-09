# Courtesy Deploy to Raspberry Pi Gateway (cst)
Write-Host ">>> Packing Courtesy project..." -ForegroundColor Cyan

$Archive = "courtesy-deploy.tar.gz"
if (Test-Path $Archive) { Remove-Item $Archive -Force }

# Create tar excluding virtualenv and cache
tar --exclude='.venv' --exclude='__pycache__' --exclude='*.pyc' -czf $Archive config src static scripts deploy requirements.txt README.md

$GatewayHost = if ($env:PI_HOST) { $env:PI_HOST } else { "cst" }
Write-Host ">>> Uploading to cst@$GatewayHost..." -ForegroundColor Cyan
scp $Archive "cst@${GatewayHost}:/tmp/$Archive"
if ($LASTEXITCODE -ne 0) {
    Write-Host ">>> Failed to connect to $GatewayHost. If using Tailscale, ensure Tailscale is connected or set `$env:PI_HOST = '100.107.249.92'." -ForegroundColor Yellow
    Remove-Item $Archive -Force -ErrorAction SilentlyContinue
    exit 1
}

if (Test-Path ".env") {
    Write-Host ">>> Uploading local .env overrides..." -ForegroundColor Cyan
    scp .env "cst@${GatewayHost}:/tmp/.env"
}

Write-Host ">>> Extracting and setting up on $GatewayHost..." -ForegroundColor Cyan
$PiSudoPass = if ($env:PI_PASSWORD) { $env:PI_PASSWORD } else { "cst" }
$EnvMoveCmd = if (Test-Path ".env") { "&& [ -f /tmp/.env ] && echo $PiSudoPass | sudo -S mv /tmp/.env /opt/courtesy/.env && echo $PiSudoPass | sudo -S chown cst:cst /opt/courtesy/.env && echo $PiSudoPass | sudo -S chmod 600 /opt/courtesy/.env" } else { "" }
ssh "cst@$GatewayHost" "echo $PiSudoPass | sudo -S mkdir -p /opt/courtesy && echo $PiSudoPass | sudo -S chmod -R 775 /opt/courtesy && echo $PiSudoPass | sudo -S rm -f /opt/courtesy/config/mining.json /opt/courtesy/src/miner_manager.py /opt/courtesy/src/openai_proxy.py /opt/courtesy/src/swarm.py /opt/courtesy/scripts/test_swarm.py && echo $PiSudoPass | sudo -S tar -xzf /tmp/$Archive -C /opt/courtesy && echo $PiSudoPass | sudo -S chown -R cst:cst /opt/courtesy && echo $PiSudoPass | sudo -S chmod -R 775 /opt/courtesy $EnvMoveCmd && rm -f /tmp/$Archive && cd /opt/courtesy && bash deploy/setup-pi.sh"

Remove-Item $Archive -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Green
Write-Host " Courtesy is now LIVE on your Raspberry Pi cluster hub!" -ForegroundColor Green
Write-Host " Dashboard:       http://100.107.249.92:8000" -ForegroundColor Cyan
Write-Host " Native Chat API: http://100.107.249.92:8000/api/chat" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Green
