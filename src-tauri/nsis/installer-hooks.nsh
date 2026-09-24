# Diver NSIS installer hooks (ASCII only)
#
# Extracted node_modules trees are runtime-generated and not in the NSIS file
# list. Clear them on upgrade install and on uninstall so the next launch
# re-extracts from the shipped tar.

!macro DiverKillLockingProcesses
  nsExec::ExecToLog 'taskkill /F /IM diver.exe /T'
  nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process -Filter \"Name=''node.exe''\" | Where-Object { $_.CommandLine -like ''*companion-bundle*'' -or $_.CommandLine -like ''*resources\\sidecar*'' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"'
  Sleep 800
!macroend

!macro DiverClearExtractedDeps
  RMDir /r "$INSTDIR\resources\sidecar\harness\node_modules"
  RMDir /r "$INSTDIR\resources\sidecar\plugins\node_modules"
  RMDir /r "$INSTDIR\resources\sidecar\node_modules"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro DiverClearExtractedDeps
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro DiverKillLockingProcesses
  !insertmacro DiverClearExtractedDeps
  Delete "$INSTDIR\resources\sidecar\harness\node_modules.tar"
  Delete "$INSTDIR\resources\sidecar\plugins\node_modules.tar"
  Delete "$INSTDIR\resources\sidecar\node_modules.tar"
  RMDir /r "$INSTDIR\resources\sidecar"
  RMDir /r "$INSTDIR\resources"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro DiverClearExtractedDeps
  RMDir /r "$INSTDIR\resources\sidecar"
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR"
!macroend
