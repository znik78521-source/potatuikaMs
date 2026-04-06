@echo off
title Potatuika Messenger
color 0A

cd /d F:\potatuika

:MENU
cls
echo =============================================
echo       POTATUIKA MESSENGER
echo =============================================
echo.
echo  Current folder: %cd%
echo.
echo  1. START server (npm start)
echo  2. UPDATE GitHub (push changes)
echo  3. UPDATE + START (both)
echo  4. STOP server
echo  5. Git STATUS
echo  6. RESET database (delete all data)
echo  7. EXIT
echo.
set /p choice="Select action (1-7): "

if "%choice%"=="1" goto START
if "%choice%"=="2" goto GIT
if "%choice%"=="3" goto BOTH
if "%choice%"=="4" goto STOP
if "%choice%"=="5" goto STATUS
if "%choice%"=="6" goto RESET
if "%choice%"=="7" goto EXIT
goto MENU

:START
cls
echo Starting server...
cd /d F:\potatuika\backend
call npm start
pause
goto MENU

:GIT
cls
echo Updating GitHub...
cd /d F:\potatuika
git add .
echo.
set /p commit_msg="Enter commit message: "
if "%commit_msg%"=="" set commit_msg=Update
git commit -m "%commit_msg%"
git push origin master --force
echo Done!
pause
goto MENU

:BOTH
cls
echo Updating GitHub...
cd /d F:\potatuika
git add .
echo.
set /p commit_msg="Enter commit message: "
if "%commit_msg%"=="" set commit_msg=Update
git commit -m "%commit_msg%"
git push origin master --force
echo GitHub updated!
echo.
echo Starting server...
cd /d F:\potatuika\backend
call npm start
pause
goto MENU

:STOP
cls
echo Stopping server...
taskkill /F /IM node.exe 2>nul
echo Server stopped.
pause
goto MENU

:STATUS
cls
cd /d F:\potatuika
git status
echo.
echo Last commits:
git log --oneline -5
pause
goto MENU

:RESET
cls
cd /d F:\potatuika
echo =============================================
echo   WARNING! This will DELETE all data!
echo =============================================
echo.
set /p confirm="Are you SURE? (y/n): "
if /i "%confirm%"=="y" (
    if exist backend\data (
        rmdir /s /q backend\data
        mkdir backend\data
    )
    echo Database reset!
) else (
    echo Cancelled
)
pause
goto MENU

:EXIT
exit