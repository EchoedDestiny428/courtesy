# Courtesy Deploy to Raspberry Pi Gateway (cst)
Write-Host ">>> Packing Courtesy project..." -ForegroundColor Cyan

$Archive = "courtesy-deploy.tar.gz"
if (Test-Path $Archive) { Remove-Item $Archive -Force }

# Create tar excluding virtualenv and cache
tar --exclude='.venv' --exclude='__pycache__' --exclude='*.pyc' -czf $Archive config src static deploy requirements.txt README.md

Write-Host ">>> Uploading to cst@cst (Tailscale)..." -ForegroundColor Cyan
scp $Archive cst@cst:/tmp/$Archive

Write-Host ">>> Extracting and setting up on cst..." -ForegroundColor Cyan
ssh cst@cst "echo cst | sudo -S mkdir -p /opt/courtesy && echo cst | sudo -S tar -xzf /tmp/$Archive -C /opt/courtesy && echo cst | sudo -S chown -R cst:cst /opt/courtesy && rm /tmp/$Archive && cd /opt/courtesy && bash deploy/setup-pi.sh"

Remove-Item $Archive -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Green
Write-Host " Courtesy is now LIVE on your Raspberry Pi cluster hub!" -ForegroundColor Green
Write-Host " Dashboard:       http://100.107.249.92:8000" -ForegroundColor Cyan
Write-Host " OpenAI API Base: http://100.107.249.92:8000/v1" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Green
