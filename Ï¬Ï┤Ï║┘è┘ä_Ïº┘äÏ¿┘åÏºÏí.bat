@echo off
chcp 65001 >nul
echo ==========================================
echo   بناء برنامج تثبيت احترافي - Setup.exe
echo   (متوافق مع ويندوز 7 / 10 / 11 - نسختي 32-bit و64-bit)
echo ==========================================
echo.
echo ملاحظة مهمة: يجب استخدام Node.js نسخة LTS حديثة (18 أو 20) من nodejs.org
echo جارٍ تثبيت المكتبات المطلوبة (أول مرة فقط، يحتاج إنترنت)...
echo يشمل ذلك مكتبة قاعدة بيانات SQLite (better-sqlite3) وإعادة بنائها تلقائياً لتتوافق مع Electron 22.
call npm install
if %errorlevel% neq 0 (
    echo.
    echo حدث خطأ أثناء التثبيت. تأكد إن Node.js مثبت على جهازك.
    echo حمّله من: https://nodejs.org
    pause
    exit /b
)
echo.
echo جارٍ بناء ملفي التثبيت Setup.exe (نسخة 32-bit ونسخة 64-bit)...
call npm run dist-win
echo.
echo ==========================================
echo   تم! افتح مجلد dist وبتلاقي ملفين:
echo   تثبيت-نظام-الكاشير-Setup-ia32.exe  (لأجهزة 32-bit)
echo   تثبيت-نظام-الكاشير-Setup-x64.exe   (لأجهزة 64-bit)
echo ==========================================
pause
