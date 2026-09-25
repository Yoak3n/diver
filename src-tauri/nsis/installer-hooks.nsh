# Diver NSIS installer hooks (ASCII only)
#
# Legacy-layout cleanup only. Since P1 the dependency closure is shipped as real
# files under resources\sidecar\node_modules — it must NOT be deleted after
# install (the old POSTINSTALL cleanup did exactly that and broke the app).
# Cleanup therefore runs in PREINSTALL, before the new files are written.

!macro DiverKillLockingProcesses
  nsExec::ExecToLog 'taskkill /F /IM diver.exe /T'
  nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process -Filter \"Name=''node.exe''\" | Where-Object { $_.CommandLine -like ''*companion-bundle*'' -or $_.CommandLine -like ''*resources\\sidecar*'' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"'
  Sleep 800
!macroend

# P0/P1 旧布局遗留（运行时解压树 / 依赖归档）清理。升级安装前执行，避免与新包
# 文件混杂；全新安装时路径不存在，无副作用。
!macro DiverClearLegacyLayouts
  RMDir /r "$INSTDIR\resources\sidecar\harness\node_modules"
  RMDir /r "$INSTDIR\resources\sidecar\plugins\node_modules"
  RMDir /r "$INSTDIR\resources\sidecar\node_modules"
  Delete "$INSTDIR\resources\sidecar\harness\node_modules.tar"
  Delete "$INSTDIR\resources\sidecar\harness\node_modules.tar.zst"
  Delete "$INSTDIR\resources\sidecar\plugins\node_modules.tar"
  Delete "$INSTDIR\resources\sidecar\plugins\node_modules.tar.zst"
  Delete "$INSTDIR\resources\sidecar\node_modules.tar"
  Delete "$INSTDIR\resources\sidecar\node_modules.tar.zst"
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro DiverClearLegacyLayouts
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro DiverKillLockingProcesses
  !insertmacro DiverClearLegacyLayouts
  RMDir /r "$INSTDIR\resources\sidecar"
  RMDir /r "$INSTDIR\resources"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro DiverClearLegacyLayouts
  RMDir /r "$INSTDIR\resources\sidecar"
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR"
!macroend
