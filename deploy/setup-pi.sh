#!/usr/bin/env bash
set -e

# =======================================================
# Courtesy AI Cluster & Codex Gateway Setup for cst (Pi)
# =======================================================

echo ">>> [1/5] Checking environment on cst..."
APP_DIR="/opt/courtesy"
sudo mkdir -p "${APP_DIR}"
sudo chown -R cst:cst "${APP_DIR}"

echo ">>> [2/5] Installing system packages..."
sudo apt-get update -y
sudo apt-get install -y python3 python3-pip python3-venv curl sshpass

echo ">>> [3/5] Setting up virtualenv..."
python3 -m venv "${APP_DIR}/.venv"
"${APP_DIR}/.venv/bin/pip" install --upgrade pip
"${APP_DIR}/.venv/bin/pip" install fastapi "uvicorn[standard]" httpx pydantic paramiko websockets jinja2 python-multipart

echo ">>> [4/5] Installing systemd service..."
cat << 'EOF' | sudo tee /etc/systemd/system/courtesy.service > /dev/null
[Unit]
Description=Courtesy Codex & AI Cluster Gateway
After=network-online.target tailscaled.service

[Service]
Type=simple
User=cst
WorkingDirectory=/opt/courtesy
ExecStart=/opt/courtesy/.venv/bin/uvicorn src.app:app --host 0.0.0.0 --port 8000
Restart=always
RestartSec=3
Environment="PYTHONUNBUFFERED=1"

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable courtesy.service
sudo systemctl restart courtesy.service

echo ">>> [5/5] Checking status..."
sleep 2
systemctl status courtesy.service --no-pager

echo ""
echo "======================================================="
echo " Courtesy Codex & Cluster is now RUNNING!"
echo " Access Dashboard: http://100.107.249.92:8000"
echo " OpenAI API Base:  http://100.107.249.92:8000/v1"
echo "======================================================="
