@echo off
rem AnimLab MotionBricks helper launcher.
rem Runs the helper inside the MotionBricks uv environment (it needs TensorRT, Warp and CUDA from there).
rem Keep this window open while you use Generate in the clip browser. Close it (or press Ctrl+C) to stop.
rem
rem If MotionBricks is somewhere else, edit MB_DIR here AND "motionbricks_dir" in config.json,
rem or run:  Start-Helper.bat "D:\other\motionbricks"

set "MB_DIR=C:\Users\User\motionbricks"
if not "%~1"=="" set "MB_DIR=%~1"

if not exist "%MB_DIR%\pyproject.toml" (
  echo Could not find MotionBricks at "%MB_DIR%".
  echo Edit MB_DIR in this file and motionbricks_dir in config.json.
  pause
  exit /b 1
)

cd /d "%MB_DIR%"
uv run python "%~dp0server.py" --motionbricks-dir "%MB_DIR%"
echo.
echo The helper stopped.
pause
