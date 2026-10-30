; ============================================================================
; QQ Agent - Windows 安装器 (NSIS 3.x / Unicode)
;
; per-user 安装: RequestExecutionLevel user, 默认 %LOCALAPPDATA%\Programs\QQAgent
; 程序入口: 载荷里的 node_modules\electron\dist\electron.exe 在打包阶段改名 "QQ Agent.exe"
; 数据目录: $INSTDIR\data (包内有 portable.flag); 升级保留, 卸载默认保留
; 编译参数: -DAPP_VERSION -DAPP_SRC -DOUT_FILE -DASSET_DIR
; ============================================================================

Unicode true

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "WinVer.nsh"
!include "x64.nsh"
!include "FileFunc.nsh"
!include "nsDialogs.nsh"

!ifndef APP_VERSION
  !define APP_VERSION "1.0.0"
!endif
!ifndef APP_SRC
  !define APP_SRC "..\..\dist-installer\app"
!endif
!ifndef OUT_FILE
  !define OUT_FILE "..\..\dist-installer\QQagent-Setup-${APP_VERSION}.exe"
!endif
!ifndef ASSET_DIR
  !define ASSET_DIR "."
!endif

!define APP_NAME      "QQ Agent"
!define APP_EXE       "QQ Agent.exe"
!define APP_SUBDIR    "node_modules\electron\dist"
!define APP_FILE      "$INSTDIR\node_modules\electron\dist\QQ Agent.exe"
!define APP_PUBLISHER "白光 (liuyuyu599com-svg)"
!define APP_REGKEY    "Software\QQAgent"
!define APP_UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\QQAgent"
!define MAX_PATH_LEN  150

!define ASSET_ICO     "${ASSET_DIR}\qqagent.ico"
!define ASSET_UNICO   "${ASSET_DIR}\uninstall.ico"
!define ASSET_WELCOME "${ASSET_DIR}\welcome.bmp"
!define ASSET_HEADER  "${ASSET_DIR}\header.bmp"

Name "${APP_NAME}"
BrandingText "${APP_NAME} ${APP_VERSION}"
OutFile "${OUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\QQAgent"
InstallDirRegKey HKCU "${APP_REGKEY}" "InstallPath"

RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 64
CRCCheck on
XPStyle on
ManifestDPIAware true

VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey /LANG=2052 "ProductName"      "${APP_NAME}"
VIAddVersionKey /LANG=2052 "FileDescription"  "QQ Agent 安装程序"
VIAddVersionKey /LANG=2052 "CompanyName"      "${APP_PUBLISHER}"
VIAddVersionKey /LANG=2052 "LegalCopyright"   "MIT License (c) 2026 ${APP_PUBLISHER}"
VIAddVersionKey /LANG=2052 "FileVersion"      "${APP_VERSION}"
VIAddVersionKey /LANG=2052 "ProductVersion"   "${APP_VERSION}"
VIAddVersionKey /LANG=2052 "OriginalFilename" "QQagent-Setup-${APP_VERSION}.exe"

Var PreserveKeep
Var PreserveCheckbox
Var PreservePageDialog

!define MUI_ABORTWARNING
!define MUI_ICON   "${ASSET_ICO}"
!define MUI_UNICON "${ASSET_UNICO}"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_BITMAP "${ASSET_HEADER}"
!define MUI_WELCOMEFINISHPAGE_BITMAP "${ASSET_WELCOME}"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "${ASSET_WELCOME}"

!define MUI_WELCOMEPAGE_TITLE "安装 QQ Agent"
!define MUI_WELCOMEPAGE_TEXT "$\r$\n这个向导会把 QQ Agent 装到你的电脑上。$\r$\n$\r$\n- 装好后桌面会有图标，双击就能用。$\r$\n- 不需要管理员权限，装在当前用户目录里。$\r$\n- 第一次使用前，请先用小号登录 PC 版 QQ，并准备好自己的 API Key。$\r$\n$\r$\n点「下一步」继续。"

!define MUI_DIRECTORYPAGE_TEXT_TOP "把 QQ Agent 装在下面这个目录。$\r$\n$\r$\n建议保持默认（在你的用户目录里，不需要管理员权限）。如果换到别的盘，完整路径不要超过 ${MAX_PATH_LEN} 个字符。"

!define MUI_FINISHPAGE_TITLE "QQ Agent 装好了"
!define MUI_FINISHPAGE_TEXT "QQ Agent ${APP_VERSION} 已安装到：$\r$\n$INSTDIR$\r$\n$\r$\n第一次启动后会自动打开控制台：先扫码登录协议端，再填群号和 API Key，点「一键启动」。$\r$\n$\r$\n卸载默认保留你的配置与聊天记录；想彻底删除请在卸载时勾选删除数据。"
!define MUI_FINISHPAGE_RUN "${APP_FILE}"
!define MUI_FINISHPAGE_RUN_TEXT "现在启动 QQ Agent"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchInstalledApp
!define MUI_FINISHPAGE_SHOWREADME "$INSTDIR\README.html"
!define MUI_FINISHPAGE_SHOWREADME_TEXT "打开使用说明（README.html）"
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED

!define MUI_UNCONFIRMPAGE_TEXT_TOP "准备卸载 QQ Agent。$\r$\n$\r$\n下一步会让你选是否连数据一起删。不确定就保留，重装后还能接着用。"
!define MUI_UNFINISHPAGE_NOAUTOCLOSE

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
UninstPage custom un.PreservePageCreate un.PreservePageLeave
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH

!insertmacro MUI_LANGUAGE "SimpChinese"

LangString DESC_CORE      ${LANG_SIMPCHINESE} "程序本体（含协议端 NapCat 与全部依赖）。必装。"
LangString DESC_DESKTOP   ${LANG_SIMPCHINESE} "在桌面放一个 QQ Agent 图标。"
LangString DESC_STARTMENU ${LANG_SIMPCHINESE} "在开始菜单建一个文件夹，含启动、使用说明与卸载。"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP|MB_OK "QQ Agent 是 64 位程序，当前系统是 32 位 Windows，装不了。"
    Abort
  ${EndIf}

  ${IfNot} ${AtLeastWin10}
    MessageBox MB_ICONEXCLAMATION|MB_YESNO "QQ Agent 需要 Windows 10 或更高版本，当前系统更老，装上也大概率起不来。$\r$\n$\r$\n仍然继续安装吗？" IDYES +2
    Abort
  ${EndIf}

  ReadRegStr $0 HKCU "${APP_REGKEY}" "InstallPath"
  ${If} $0 != ""
    StrCpy $INSTDIR $0
  ${EndIf}
FunctionEnd

Function .onVerifyInstDir
  StrLen $0 "$INSTDIR"
  ${If} $0 > ${MAX_PATH_LEN}
    Abort
  ${EndIf}
  ${If} $INSTDIR == ""
    Abort
  ${EndIf}
FunctionEnd

Section "QQ Agent 主程序" SEC_CORE
  SectionIn RO

  nsExec::ExecToLog 'taskkill /IM "${APP_EXE}" /F'
  Pop $0
  Sleep 400

  CreateDirectory "$INSTDIR\_qqagent_preserve"
  IfFileExists "$INSTDIR\data\*.*" 0 +3
    Rename "$INSTDIR\data" "$INSTDIR\_qqagent_preserve\data"
    Goto +1

  IfFileExists "$INSTDIR\snowluma\config\*.*" 0 +3
    CreateDirectory "$INSTDIR\_qqagent_preserve\snowluma"
    Rename "$INSTDIR\snowluma\config" "$INSTDIR\_qqagent_preserve\snowluma\config"

  IfFileExists "$INSTDIR\snowluma\logs\*.*" 0 +3
    CreateDirectory "$INSTDIR\_qqagent_preserve\snowluma"
    Rename "$INSTDIR\snowluma\logs" "$INSTDIR\_qqagent_preserve\snowluma\logs"

  IfFileExists "$INSTDIR\dsh-work\*.*" 0 +2
    Rename "$INSTDIR\dsh-work" "$INSTDIR\_qqagent_preserve\dsh-work"

  SetOutPath "$INSTDIR"
  File /r "${APP_SRC}\*.*"

  IfFileExists "$INSTDIR\_qqagent_preserve\data\*.*" 0 +3
    RMDir /r "$INSTDIR\data"
    Rename "$INSTDIR\_qqagent_preserve\data" "$INSTDIR\data"

  IfFileExists "$INSTDIR\_qqagent_preserve\snowluma\config\*.*" 0 +3
    RMDir /r "$INSTDIR\snowluma\config"
    Rename "$INSTDIR\_qqagent_preserve\snowluma\config" "$INSTDIR\snowluma\config"

  IfFileExists "$INSTDIR\_qqagent_preserve\snowluma\logs\*.*" 0 +3
    RMDir /r "$INSTDIR\snowluma\logs"
    Rename "$INSTDIR\_qqagent_preserve\snowluma\logs" "$INSTDIR\snowluma\logs"

  IfFileExists "$INSTDIR\_qqagent_preserve\dsh-work\*.*" 0 +2
    RMDir /r "$INSTDIR\dsh-work"
    Rename "$INSTDIR\_qqagent_preserve\dsh-work" "$INSTDIR\dsh-work"

  RMDir /r "$INSTDIR\_qqagent_preserve"

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  WriteRegStr HKCU "${APP_REGKEY}" "InstallPath" "$INSTDIR"
  WriteRegStr HKCU "${APP_REGKEY}" "Version" "${APP_VERSION}"
  WriteRegStr HKCU "${APP_UNINSTKEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${APP_UNINSTKEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${APP_UNINSTKEY}" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKCU "${APP_UNINSTKEY}" "DisplayIcon" "${APP_FILE}"
  WriteRegStr HKCU "${APP_UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${APP_UNINSTKEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${APP_UNINSTKEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${APP_UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${APP_UNINSTKEY}" "NoRepair" 1

  ; GetSize 的输出顺序：$0=体积（KB，因 /S=0K）、$1=文件数、$2=文件夹数。
  ; EstimatedSize 要的是 KB 体积，用 $0；误用 $1 会写成文件数。
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKCU "${APP_UNINSTKEY}" "EstimatedSize" "$0"
SectionEnd

Section "桌面快捷方式" SEC_DESKTOP
  CreateShortCut "$DESKTOP\${APP_NAME}.lnk" "${APP_FILE}" '"$INSTDIR"' "${APP_FILE}" 0 SW_SHOWNORMAL "" "启动 ${APP_NAME}"
SectionEnd

Section "开始菜单快捷方式" SEC_STARTMENU
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "${APP_FILE}" '"$INSTDIR"' "${APP_FILE}" 0
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\使用说明.lnk" "$INSTDIR\README.html" "" "$INSTDIR\README.html" 0
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\卸载 ${APP_NAME}.lnk" "$INSTDIR\Uninstall.exe" "" "$INSTDIR\Uninstall.exe" 0
SectionEnd

Function LaunchInstalledApp
  Exec '"${APP_FILE}" "$INSTDIR"'
FunctionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_CORE}      $(DESC_CORE)
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_DESKTOP}   $(DESC_DESKTOP)
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_STARTMENU} $(DESC_STARTMENU)
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Section "Uninstall"
  nsExec::ExecToLog 'taskkill /IM "${APP_EXE}" /F'
  Pop $0
  Sleep 400

  Delete "$DESKTOP\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\使用说明.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\卸载 ${APP_NAME}.lnk"
  RMDir "$SMPROGRAMS\${APP_NAME}"
  DeleteRegKey HKCU "${APP_UNINSTKEY}"
  DeleteRegKey HKCU "${APP_REGKEY}"

  RMDir /r "$TEMP\qqagent-data-keep"
  ${If} $PreserveKeep == "1"
    Rename "$INSTDIR\data" "$TEMP\qqagent-data-keep"
    RMDir /r "$INSTDIR"
    CreateDirectory "$INSTDIR"
    Rename "$TEMP\qqagent-data-keep" "$INSTDIR\data"
    ${IfNot} ${Silent}
      MessageBox MB_ICONINFORMATION|MB_OK "已卸载 QQ Agent。$\r$\n$\r$\n你的配置、聊天记录与记忆仍保留在：$\r$\n$INSTDIR\data$\r$\n$\r$\n想彻底删掉的话，直接删这个文件夹即可。"
    ${EndIf}
  ${Else}
    RMDir /r "$INSTDIR"
  ${EndIf}
SectionEnd

Function un.PreservePageCreate
  !insertmacro MUI_HEADER_TEXT "卸载选项" "选择是否保留你的数据"

  nsDialogs::Create 1018
  Pop $PreservePageDialog
  ${If} $PreservePageDialog == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 46u "卸载程序会删掉程序文件、桌面图标与开始菜单项。$\r$\n$\r$\n你的 data 文件夹里有：API Key、群号设置、聊天记录、记忆与日记。删掉就无法恢复。"
  Pop $0
  ${NSD_CreateCheckbox} 0 52u 100% 22u "一并删除 data 文件夹（配置 / 聊天记录 / 记忆）"
  Pop $PreserveCheckbox

  ${If} $PreserveKeep == "0"
    ${NSD_SetState} $PreserveCheckbox ${BST_CHECKED}
  ${EndIf}

  nsDialogs::Show
FunctionEnd

Function un.PreservePageLeave
  ${NSD_GetState} $PreserveCheckbox $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $PreserveKeep "0"
  ${Else}
    StrCpy $PreserveKeep "1"
  ${EndIf}
FunctionEnd

Function un.onInit
  StrCpy $PreserveKeep "1"
  ; 静默卸载不会走自定义页，所以给脚本留一个显式开关：
  ;   Uninstall.exe /S /PURGEDATA=1   —— 连 data 一起删
  ; 不写这个参数就一律保留数据，宁可不删，也别替别人删掉聊天记录。
  ${GetParameters} $0
  ${GetOptions} $0 "/PURGEDATA=" $1
  ${If} $1 == "1"
    StrCpy $PreserveKeep "0"
  ${EndIf}
FunctionEnd
