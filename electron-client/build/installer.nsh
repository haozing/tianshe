!macro customInit
  ${nsProcess::FindProcess} "赤狐管家内测.exe" $R0
  ${If} $R0 == 0
    MessageBox MB_ICONEXCLAMATION|MB_OK "请先完全退出赤狐管家，再继续安装。"
    Abort
  ${EndIf}
!macroend

!macro customInstall
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\f6426e21-e21c-5be8-9879-1b8b34f76b94"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\f6426e21-e21c-5be8-9879-1b8b34f76b94"
  Delete "$INSTDIR\赤狐管家内测.exe"
  Delete "$INSTDIR\Uninstall 赤狐管家内测.exe"

  SetShellVarContext current
  Delete "$DESKTOP\赤狐管家内测.lnk"
  Delete "$SMPROGRAMS\赤狐管家内测.lnk"
  SetShellVarContext all
  Delete "$DESKTOP\赤狐管家内测.lnk"
  Delete "$SMPROGRAMS\赤狐管家内测.lnk"
  ${If} $installMode == "current"
    SetShellVarContext current
  ${EndIf}
!macroend
