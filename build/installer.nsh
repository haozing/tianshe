; TiansheAI - NSIS 自定义安装脚本
; 此脚本用于自定义 Windows 安装程序的行为

; VC++ Runtime 检测和安装
!include "x64.nsh"
!include "WinVer.nsh"

; VC++ Redistributable 下载 URL (Microsoft 官方链接)
!define VC_REDIST_URL "https://aka.ms/vs/17/release/vc_redist.x64.exe"
!define VC_REDIST_FILE "vc_redist.x64.exe"

; 检查 VC++ Runtime 是否已安装
; 通过检查注册表中的版本号来判断
!macro CheckVCRedist
  ; onnxruntime-node / 其他原生模块通常至少依赖：
  ; - VCRUNTIME140.dll
  ; - VCRUNTIME140_1.dll（较新的 VC++ runtime 才包含；缺失时经常表现为 “DLL initialization routine failed”）
  ; - MSVCP140.dll
  ;
  ; 先用 “文件存在” 做快速判断，随后再用注册表做兜底。
  IfFileExists "$SYSDIR\VCRUNTIME140.dll" +2 vcredist_check_registry
  Goto vcredist_check_registry
  IfFileExists "$SYSDIR\VCRUNTIME140_1.dll" +2 vcredist_check_registry
  Goto vcredist_check_registry
  IfFileExists "$SYSDIR\MSVCP140.dll" vcredist_found vcredist_check_registry

  vcredist_check_registry:
    ; 备用检查：通过注册表
    ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
    ${If} $0 == 1
      ; Installed=1 仍可能是旧版/不完整运行库，这里再做一次关键文件确认
      IfFileExists "$SYSDIR\VCRUNTIME140.dll" +2 vcredist_not_found
      Goto vcredist_not_found
      IfFileExists "$SYSDIR\VCRUNTIME140_1.dll" +2 vcredist_not_found
      Goto vcredist_not_found
      IfFileExists "$SYSDIR\MSVCP140.dll" vcredist_found vcredist_not_found
    ${EndIf}

    ; VC++ Runtime 未找到，需要安装
    Goto vcredist_not_found

  vcredist_found:
    DetailPrint "VC++ Runtime 已安装"
    Goto vcredist_done

  vcredist_not_found:
    DetailPrint "需要安装 VC++ Runtime..."

    ; 显示提示信息
    MessageBox MB_YESNO|MB_ICONINFORMATION "TiansheAI 需要 Microsoft Visual C++ Runtime 才能运行。$\n$\n是否现在下载并安装？$\n$\n(文件大小约 25MB，需要网络连接)" IDYES download_vcredist IDNO skip_vcredist

  download_vcredist:
    ; 创建临时目录
    CreateDirectory "$TEMP\tiansheai_setup"

    ; 下载 VC++ Redistributable
    DetailPrint "正在下载 VC++ Runtime..."
    NSISdl::download "${VC_REDIST_URL}" "$TEMP\tiansheai_setup\${VC_REDIST_FILE}"
    Pop $0
    ${If} $0 != "success"
      MessageBox MB_OK|MB_ICONEXCLAMATION "下载 VC++ Runtime 失败。$\n$\n请手动从以下地址下载安装：$\n${VC_REDIST_URL}$\n$\n安装完成后重新运行本程序。"
      Goto vcredist_done
    ${EndIf}

    ; 静默安装 VC++ Redistributable
    DetailPrint "正在安装 VC++ Runtime..."
    ExecWait '"$TEMP\tiansheai_setup\${VC_REDIST_FILE}" /install /quiet /norestart' $1

    ${If} $1 != 0
      ; 安装可能需要重启，或者用户取消了
      ${If} $1 == 3010
        ; 需要重启
        MessageBox MB_OK|MB_ICONINFORMATION "VC++ Runtime 安装成功，但需要重启计算机。$\n$\n请在重启后重新运行安装程序。"
        Abort
      ${Else}
        MessageBox MB_OK|MB_ICONEXCLAMATION "VC++ Runtime 安装可能未完成 (错误代码: $1)。$\n$\n如果程序无法启动，请手动安装 VC++ Runtime。"
      ${EndIf}
    ${Else}
      DetailPrint "VC++ Runtime 安装成功"
    ${EndIf}

    ; 清理临时文件
    Delete "$TEMP\tiansheai_setup\${VC_REDIST_FILE}"
    RMDir "$TEMP\tiansheai_setup"
    Goto vcredist_done

  skip_vcredist:
    MessageBox MB_OK|MB_ICONEXCLAMATION "跳过 VC++ Runtime 安装。$\n$\n如果程序无法启动，请手动从以下地址下载安装：$\n${VC_REDIST_URL}"

  vcredist_done:
!macroend

!macro preInit
  ; 安装前初始化
  SetRegView 64
  WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "$INSTDIR"
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$INSTDIR"
  SetRegView 32
  WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "$INSTDIR"
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$INSTDIR"
!macroend

!macro customInstall
  ; 自定义安装步骤
  DetailPrint "正在安装 TiansheAI..."

  ; 首先检查并安装 VC++ Runtime（如果需要）
  !insertmacro CheckVCRedist

  ; 创建数据目录
  CreateDirectory "$INSTDIR\data"

  ; 创建插件目录
  CreateDirectory "$INSTDIR\plugins"

  DetailPrint "TiansheAI 安装完成"
!macroend

!macro customUnInstall
  ; 自定义卸载步骤
  DetailPrint "正在卸载 TiansheAI..."

  ; 询问是否删除用户数据
  MessageBox MB_YESNO|MB_ICONQUESTION "是否删除所有用户数据和配置？$\n$\n选择'是'将删除数据库、插件和配置文件。$\n选择'否'将保留这些文件。" IDNO skip_data_delete

    ; 删除用户数据
    RMDir /r "$INSTDIR\data"
    RMDir /r "$INSTDIR\plugins"

    ; 删除应用数据目录
    RMDir /r "$APPDATA\tiansheai"

    DetailPrint "用户数据已删除"
    Goto done_delete

  skip_data_delete:
    DetailPrint "保留用户数据"

  done_delete:
    DetailPrint "TiansheAI 卸载完成"
!macroend

!macro customHeader
  ; 自定义安装程序头部
  !system "echo '正在准备安装程序...'"
!macroend

!macro customInit
  ; 检查是否已经安装
  ReadRegStr $0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_GUID}" "UninstallString"
  ${If} $0 != ""
    MessageBox MB_YESNO|MB_ICONQUESTION "检测到 TiansheAI 已安装。$\n$\n是否要卸载旧版本后继续安装？" IDYES uninst
    Abort

    uninst:
      ; 运行卸载程序
      ExecWait '$0 _?=$INSTDIR'
  ${EndIf}
!macroend
