# Courtesy Deploy to Raspberry Pi Gateway (cst)
Write-Host ">>> Packing Courtesy project..." -ForegroundColor Cyan

$Archive = "courtesy-deploy.tar.gz"
if (Test-Path $Archive) { Remove-Item $Archive -Force }

# Create tar excluding virtualenv and cache
tar --exclude='.venv' --exclude='__pycache__' --exclude='*.pyc' -czf $Archive config src static scripts deploy requirements.txt README.md

Write-Host ">>> Uploading to cst@cst (Tailscale)..." -ForegroundColor Cyan
scp $Archive cst@cst:/tmp/$Archive

Write-Host ">>> Extracting and setting up on cst..." -ForegroundColor Cyan
$PiSudoPass = if ($env:PI_PASSWORD) { $env:PI_PASSWORD } else { "cst" }
ssh cst@cst "echo $PiSudoPass | sudo -S mkdir -p /opt/courtesy && echo $PiSudoPass | sudo -S chmod -R 775 /opt/courtesy && echo $PiSudoPass | sudo -S rm -f /opt/courtesy/config/mining.json /opt/courtesy/src/miner_manager.py /opt/courtesy/src/openai_proxy.py /opt/courtesy/src/swarm.py /opt/courtesy/scripts/test_swarm.py && echo $PiSudoPass | sudo -S tar -xzf /tmp/$Archive -C /opt/courtesy && echo $PiSudoPass | sudo -S chown -R cst:cst /opt/courtesy && echo $PiSudoPass | sudo -S chmod -R 775 /opt/courtesy && rm /tmp/$Archive && cd /opt/courtesy && bash deploy/setup-pi.sh"

Remove-Item $Archive -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Green
Write-Host " Courtesy is now LIVE on your Raspberry Pi cluster hub!" -ForegroundColor Green
Write-Host " Dashboard:       http://100.107.249.92:8000" -ForegroundColor Cyan
Write-Host " Native Chat API: http://100.107.249.92:8000/api/chat" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Green
