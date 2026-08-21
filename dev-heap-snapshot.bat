@echo off
setlocal
cd /d "%~dp0"

rem ---------------------------------------------------------------------------
rem  Launch AIDE in dev mode with V8 heap snapshotting armed.
rem
rem  The first time the main-process heap crosses 60%% of the V8 cap, the
rem  diagnostics recorder writes ONE .heapsnapshot and logs 'heap-snapshot-written'.
rem  Open it in Chrome DevTools -> Memory -> Load to see what is holding the heap.
rem
rem  The process freezes while the snapshot is written, and the file is roughly
rem  the size of the heap (expect 2-3 GB). That is why this is a separate
rem  launcher and not the default.
rem ---------------------------------------------------------------------------

set "AIDE_HEAP_SNAPSHOT=1"

echo.
echo   AIDE dev - heap snapshot ARMED
echo.
echo   Snapshot and event trail:  %APPDATA%\aide\diagnostics
echo   After a crash, run:        npm run diagnose
echo.
echo   Expect a freeze of several seconds when the snapshot is taken.
echo.

call npm run dev

echo.
echo   Dev server exited.
echo.
pause
endlocal
