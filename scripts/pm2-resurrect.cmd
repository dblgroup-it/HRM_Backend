@echo off
REM ---------------------------------------------------------------------------
REM Restore the pm2-managed HRM backend after a server reboot.
REM
REM `pm2 startup` only supports Linux init systems ("Init system not found" on
REM Windows), so reboot persistence is handled by the "PM2 HRM Backend"
REM scheduled task, which runs this script at system startup as SYSTEM.
REM
REM PM2_HOME must be set explicitly: the saved process list lives in the
REM Administrator profile, but the task runs as SYSTEM, whose profile is
REM elsewhere. Without this, resurrect finds no dump.pm2 and restores nothing.
REM
REM To re-save after changing what pm2 runs:  pm2 save
REM ---------------------------------------------------------------------------
set "PM2_HOME=C:\Users\Administrator\.pm2"
"C:\Users\Administrator\AppData\Roaming\npm\pm2.cmd" resurrect
