# Courtesy Local Windows Runner
Write-Host ">>> Starting Courtesy Codex & AI Cluster Fleet..." -ForegroundColor Cyan

$VenvPython = ".\.venv\Scripts\python.exe"
if (-not (Test-Path $VenvPython)) {
    Write-Host "Creating virtual environment..." -ForegroundColor Yellow
    python -m venv .venv
    & $VenvPython -m pip install -r requirements.txt
}

Write-Host "Launching web dashboard and API on http://localhost:8000..." -ForegroundColor Green
& $VenvPython -m uvicorn src.app:app --host 0.0.0.0 --port 8000 --reload
