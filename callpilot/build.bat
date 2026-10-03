@echo off
REM Build CallPilot.exe on Windows. Requires Python 3.11 or 3.12 on PATH.
setlocal
cd /d "%~dp0"
if not exist .venv (
    py -3.12 -m venv .venv 2>nul || python -m venv .venv
)
call .venv\Scripts\activate.bat
python -m pip install --upgrade pip
pip install -r requirements-dev.txt || goto :error
python -m pytest -q || goto :error
pyinstaller packaging\CallPilot.spec --noconfirm --clean || goto :error
where iscc >nul 2>nul && iscc packaging\CallPilot.iss
echo.
echo Done:  dist\CallPilot.exe
if exist dist\CallPilot-Setup.exe echo        dist\CallPilot-Setup.exe
goto :eof
:error
echo Build failed.
exit /b 1
