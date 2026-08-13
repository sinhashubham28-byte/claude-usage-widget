; Custom NSIS hooks for electron-builder.
; The app enables "Start with Windows" via a HKCU Run key (Electron's
; app.setLoginItemSettings) using the same value name every time —
; AUTOLAUNCH_NAME in main.js, kept in sync with the string below by hand.
; The uninstaller doesn't run the app's JS, so it has to remove that
; registry value itself; otherwise a stale, unrunnable Run entry would be
; left behind after uninstall.

!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Claude Usage"
!macroend
