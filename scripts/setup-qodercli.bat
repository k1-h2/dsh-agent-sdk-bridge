@echo off
rem =====================================================================
rem  Qoder CLI - install / login helper                  (Windows only)
rem
rem  Keep this file ASCII-only. cmd.exe loses its byte position inside a
rem  batch file that holds multibyte characters whenever it runs without a
rem  console - which is how the DSH settings page starts it - and the tail of
rem  such a line then executes as a command.
rem
rem  usage:
rem    setup-qodercli.bat            install if missing, then sign in + verify
rem    setup-qodercli.bat --check    verify only, installs nothing, no pause
rem    setup-qodercli.bat --login    sign in again only, for switching account
rem    setup-qodercli.bat --gui      same as no args, but never pauses at the
rem                                    end; the DSH settings page shows the
rem                                    output of such a run live
rem    setup-qodercli.bat /?         this help
rem =====================================================================
setlocal EnableExtensions EnableDelayedExpansion

set "PKG=@qoder-ai/qodercli"
set "MODE=setup"
if /I "%~1"=="--check" set "MODE=check"
if /I "%~1"=="--login" set "MODE=login"
if /I "%~1"=="--logout" set "MODE=logout"
if /I "%~1"=="--uninstall" set "MODE=uninstall"
if /I "%~1"=="/?"      goto :usage

echo.
echo  ==============================================================
if "%MODE%"=="check" echo   Qoder CLI - check only, nothing installed or changed
if "%MODE%"=="login" echo   Qoder CLI - re-login only, nothing installed
if "%MODE%"=="logout" echo   Qoder CLI - sign out, removing the saved credential
if "%MODE%"=="setup" echo   Qoder CLI - install and sign-in wizard
if "%MODE%"=="uninstall" echo   Qoder CLI - remove the global CLI package
echo  ==============================================================

rem ---------------------------------------------------------------- 1 node
echo.
if "%MODE%"=="logout" echo [1/3] Node.js and npm
if "%MODE%"=="uninstall" echo [1/3] Node.js and npm
if not "%MODE%"=="logout" if not "%MODE%"=="uninstall" echo [1/5] Node.js and npm
where node >nul 2>nul
if errorlevel 1 (
    echo       [X] node not found. Install Node.js LTS first:
    echo             https://nodejs.org/en
    echo           then close this window and run the script again.
    goto :fail
)
for /f "delims=" %%V in ('node -v 2^>nul')  do set "NODEV=%%V"
for /f "delims=" %%V in ('npm -v  2^>nul')  do set "NPMV=%%V"
if not defined NPMV (
    echo       [X] node !NODEV! is there but npm is not. Reinstall Node.js.
    goto :fail
)
echo       [OK] node !NODEV! / npm !NPMV!

rem global npm shims live here; prepend so a fresh install is visible at once
set "PATH=%APPDATA%\npm;%PATH%"
for /f "delims=" %%P in ('npm config get prefix 2^>nul') do set "NPREFIX=%%P"
if defined NPREFIX set "PATH=%NPREFIX%;%PATH%"

if "%MODE%"=="uninstall" goto :uninstall
if "%MODE%"=="logout" goto :logout

rem ------------------------------------------------------------- 2 detect
echo.
echo [2/5] %PKG%
set "QCMD="
for /f "delims=" %%P in ('where qodercli.cmd 2^>nul') do if not defined QCMD set "QCMD=%%P"
if not defined QCMD if exist "%APPDATA%\npm\qodercli.cmd" set "QCMD=%APPDATA%\npm\qodercli.cmd"

set "CLIV="
if defined QCMD for /f "delims=" %%V in ('call "!QCMD!" --version 2^>nul') do if not defined CLIV set "CLIV=%%V"
if defined CLIV (
    echo       [OK] already installed %CLIV%
    echo             %QCMD%
) else (
    echo       [--] qodercli not found
)

rem The SDK speaks a wire protocol that is pinned to one CLI release. CLI
rem 1.1.81 dropped the old SDK session handshake and exits 42 on it, which the
rem settings page could only report as "process exited with code 42". Reading
rem the requirement from the installed SDK keeps this helper on a version the
rem plugin can actually talk to, instead of whatever latest happens to be.
set "WANTV="
set "MANIFEST=%~dp0..\node_modules\@qoder-ai\qoder-agent-sdk\dist\runtime-manifest.json"
if exist "%MANIFEST%" for /f "usebackq delims=" %%V in (`node -e "try{process.stdout.write(require(process.argv[1]).qoderCliVersion||'')}catch(e){}" "%MANIFEST%"`) do set "WANTV=%%V"
set "PKGSPEC=%PKG%"
if defined WANTV set "PKGSPEC=%PKG%@%WANTV%"
if defined WANTV echo       [--] this plugin needs CLI !WANTV!

rem ------------------------------------------------------------- 3 install
echo.
echo [3/5] Install the CLI
if not "%MODE%"=="setup" (
    if not defined QCMD (
        echo       [X] not installed, and %MODE% mode will not install it.
        echo             Run this script without an argument to install it.
        goto :fail
    )
    if defined WANTV if not "!CLIV!"=="!WANTV!" (
        echo       [X] installed !CLIV!, but this plugin needs !WANTV!.
        echo             Run this script without an argument to install it.
        goto :fail
    )
    echo       [--] %MODE% mode, skipping install
    goto :login
)
if defined QCMD (
    if not defined WANTV goto :skipinstall
    if "!CLIV!"=="!WANTV!" goto :skipinstall
    echo       [--] installed !CLIV!, this plugin needs !WANTV! - reinstalling
    goto :doinstall
)
:skipinstall
if defined QCMD (
    echo       [--] already on !CLIV!, skipping install.
    echo             latest version: qodercli update
    goto :login
)
:doinstall
echo       running npm install -g %PKGSPEC% ... needs network, please wait
call npm install -g "%PKGSPEC%"
if not errorlevel 1 goto :installed
echo       [X] npm install failed. Usual causes:
echo             1 DEPTH_ZERO_SELF_SIGNED_CERT
echo               run  set NODE_OPTIONS=--use-system-ca  and start this again
echo             2 the npm registry is unreachable
echo               check  npm config get registry  and any proxy settings
echo             3 not enough permissions
echo               open this script as Administrator
goto :fail

:installed
set "QCMD="
set "CLIV="
for /f "delims=" %%P in ('where qodercli.cmd 2^>nul') do if not defined QCMD set "QCMD=%%P"
if not defined QCMD if exist "%APPDATA%\npm\qodercli.cmd" set "QCMD=%APPDATA%\npm\qodercli.cmd"
if not defined QCMD (
    echo       [X] installed, but qodercli is still not on PATH.
    echo             Open a new terminal window and run the script again.
    goto :fail
)
for /f "delims=" %%V in ('call "!QCMD!" --version 2^>nul') do if not defined CLIV set "CLIV=%%V"
echo       [OK] installed %CLIV%

rem --------------------------------------------------------------- 4 login
:login
echo.
echo [4/5] Sign in to Qoder
if "%MODE%"=="check" (
    echo       [--] check mode, only verifying the sign-in state
    goto :verify
)
set "ST=%TEMP%\setup-qodercli-status.txt"
if "%MODE%"=="login" (
    echo       Re-login: the browser sign-in opens even when this machine is
    echo       already signed in, so you can move to another account.
    goto :signin
)
call "!QCMD!" status > "%ST%" 2>&1
findstr /I /C:"Username" "%ST%" >nul 2>nul
if not errorlevel 1 goto :already
echo       Not signed in yet, so the browser sign-in starts now.
:signin
echo       No account yet? Register at https://qoder.com first.
echo       If a sign-in link is printed below, open it in your browser.
echo       Finish it there; this script keeps checking by itself.
call "!QCMD!" login
set "TRY=0"
:poll
set /a TRY+=1
call "!QCMD!" status > "%ST%" 2>&1
findstr /I /C:"Username" "%ST%" >nul 2>nul
if not errorlevel 1 goto :oklogin
if %TRY% GEQ 24 (
    echo       [X] still no sign-in after about 2 minutes.
    echo             Run  qodercli login  by itself to see what it reports.
    goto :fail
)
echo       ... still waiting for the browser sign-in ^(!TRY!/24^), retrying in 5s
rem ping, not timeout: this script also runs with redirected pipes from DSH,
rem where timeout refuses to work because stdin is not a console.
ping -n 6 127.0.0.1 >nul 2>&1
goto :poll

:already
echo       [OK] already signed in, nothing to do.
echo             another account? run  qodercli login
goto :verify

:oklogin
echo       [OK] signed in

rem ------------------------------------------------------------- 5 verify
:verify
echo.
echo [5/5] Verify
for /f "delims=" %%V in ('call "!QCMD!" --version 2^>nul') do echo       CLI version        %%V

if not defined ST set "ST=%TEMP%\setup-qodercli-status.txt"
if "%MODE%"=="check" call "!QCMD!" status > "%ST%" 2>&1
findstr /I /C:"Username" "%ST%" >nul 2>nul
if errorlevel 1 (
    echo       [X] not signed in. Run  qodercli login
    goto :fail
)
for /f "tokens=*" %%L in ('findstr /I /R /C:"^Username" /C:"^User Type" "%ST%" 2^>nul') do echo       %%L

if exist "%USERPROFILE%\.qoder\.auth" (
    echo       credential dir  OK   %USERPROFILE%\.qoder\.auth
) else (
    echo       [note] no %USERPROFILE%\.qoder\.auth yet - the plugin reads exactly that sign-in
)

set "MC=0"
for /f "skip=1 delims=" %%L in ('call "!QCMD!" --list-models 2^>nul') do set /a MC+=1
if %MC% GEQ 1 (
    echo       models on plan     !MC!
) else (
    echo       [X] empty model list: the account may have no subscription, or the
    echo             sign-in did not take effect.
    goto :fail
)

echo.
echo  ==============================================================
echo   All good. Back in DSH the plugin needs no API key: it reuses
echo   this sign-in. Pick a Qoder model and start chatting.
echo  ==============================================================
goto :done

:uninstall
echo.
echo [2/3] Uninstall %PKG%
call npm uninstall -g "%PKG%"
if errorlevel 1 (
    echo       [X] npm uninstall failed.
    echo           Open this script as Administrator and run it again.
    goto :fail
)
echo       [OK] %PKG% removed

rem npm leaves the scope directory and the shims behind, and both the
rem plugin's CLI lookup and the page's "installed?" badge read them. Clearing
rem them here is what actually makes the page switch back to "install".
echo.
echo [3/3] Clean leftovers
if exist "%APPDATA%\npm\node_modules\@qoder-ai\qodercli" rd /s /q "%APPDATA%\npm\node_modules\@qoder-ai\qodercli" 2>nul
dir /b "%APPDATA%\npm\node_modules\@qoder-ai" 2>nul | findstr /r "." >nul
if errorlevel 1 rd /s /q "%APPDATA%\npm\node_modules\@qoder-ai" 2>nul
call :delshims qodercli qoder
echo       [OK] shims and empty scope dir cleared

echo.
echo  ==============================================================
echo   Uninstalled. Sign-in files under %USERPROFILE%\.qoder are kept;
echo   run this script again without --uninstall to reinstall and sign in.
echo  ==============================================================
goto :done

:logout
echo.
echo [2/3] Find the CLI
set "QCMD="
for /f "delims=" %%P in ('where qodercli.cmd 2^>nul') do if not defined QCMD set "QCMD=%%P"
if not defined QCMD if exist "%APPDATA%\\npm\\qodercli.cmd" set "QCMD=%APPDATA%\\npm\\qodercli.cmd"
if not defined QCMD (
    echo       [X] qodercli is not installed, so there is no sign-in to clear.
    echo           Run this script without an argument to install it.
    goto :fail
)
echo       [OK] !QCMD!

rem The CLI has no logout subcommand: its only credential is the encrypted
rem ~/.qoder/.auth/user file, and a fresh process with that file gone reports
rem no Username. machine_id stays, because it identifies this machine rather
rem than the account.
echo.
echo [3/3] Remove the saved sign-in
set "AUTH=%USERPROFILE%\\.qoder\\.auth\\user"
if exist "%AUTH%" (
    del /q "%AUTH%" 2>nul
    if exist "%AUTH%" (
        echo       [X] could not remove %AUTH%
        echo           Close DSH and any running qodercli, then try again.
        goto :fail
    )
    echo       [OK] saved credential removed
) else (
    echo       [--] no saved credential found; nothing to remove
)
set "ST=%TEMP%\\setup-qodercli-status.txt"
call "!QCMD!" status > "%ST%" 2>&1
findstr /I /C:"Username" "%ST%" >nul 2>nul
if not errorlevel 1 (
    echo       [X] the CLI still reports a signed-in user.
    echo           Close DSH and try again; if it persists, remove
    echo           %AUTH% by hand.
    goto :fail
)
echo       [OK] signed out; the next login asks for a fresh browser sign-in
echo.
echo  ==============================================================
echo   You are signed out of Qoder International. Quota is cleared
echo   and open sessions were closed; sign in again to continue.
echo  ==============================================================
goto :done

rem Delete the npm shim trio for each name given, ignoring absent ones.
:delshims
if "%~1"=="" goto :eof
if exist "%APPDATA%\npm\%~1.cmd" del /q "%APPDATA%\npm\%~1.cmd" 2>nul
if exist "%APPDATA%\npm\%~1.ps1" del /q "%APPDATA%\npm\%~1.ps1" 2>nul
if exist "%APPDATA%\npm\%~1" del /q "%APPDATA%\npm\%~1" 2>nul
shift
goto :delshims

:usage
echo.
echo   setup-qodercli.bat            install what is missing, then sign in
echo   setup-qodercli.bat --check    verify only: version / sign-in / dirs / models
echo   setup-qodercli.bat --login    re-open the browser sign-in, install nothing
echo   setup-qodercli.bat --logout   sign out, removing the saved credential
echo   setup-qodercli.bat --gui      as above but never pauses, for the DSH page
echo   setup-qodercli.bat --uninstall  remove the global CLI package
echo   setup-qodercli.bat /?         this help
echo.
set "MODE=check"
goto :verify

:fail
echo.
echo  Step failed - fix the [X] above, then run this script again.
if "%~1"=="" pause
endlocal & exit /b 1

:done
del "%ST%" >nul 2>nul
if "%~1"=="" pause
endlocal & exit /b 0
