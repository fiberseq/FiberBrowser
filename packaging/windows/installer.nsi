; FiberBrowser-<version>-Setup.exe: installs FiberBrowser for the current user,
; without administrator rights (unless WSL itself must be installed).
;
; - checks that WSL 2 is available; if not, explains and offers to install it
;   (wsl --install --no-distribution: administrator approval, often a restart;
;   Setup then starts again after the next sign-in to finish);
; - imports FiberBrowser's own WSL distribution ("FiberBrowser") into
;   %LOCALAPPDATA%\FiberBrowser\distro (your other distributions are not touched;
;   reinstalling or updating keeps your FiberBrowser data);
; - Start-menu and desktop shortcuts; an uninstaller in Apps & features, which
;   removes the distribution and keeps your data unless you ask.
;
; The work is done by app\FiberBrowserSetup.ps1 (shared with the portable
; package). Built by build_installer.sh:
;   makensis -DVERSION=3.0.0 -DROOTFS=<rootfs.tar.gz> -DAPPDIR=<staged app folder> \
;            -DLICENSE=<LICENSE> -DOUTFILE=FiberBrowser-3.0.0-Setup.exe installer.nsi
Unicode true
ManifestDPIAware true
!define APP "FiberBrowser"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\FiberBrowser"
!define RUNONCE_KEY "Software\Microsoft\Windows\CurrentVersion\RunOnce"

Name "${APP} ${VERSION}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\${APP}"
RequestExecutionLevel user
SetCompressor lzma  ; not /SOLID: the rootfs (already gzip) is stored with SetCompress off
BrandingText "${APP} ${VERSION}"
ShowInstDetails show
ShowUninstDetails show
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APP}"
VIAddVersionKey "FileDescription" "${APP} ${VERSION} Setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "FiberBrowser Authors"
VIAddVersionKey "LegalCopyright" "MIT License"

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

!define MUI_ICON "${APPDIR}\FiberBrowser.ico"
!define MUI_UNICON "${APPDIR}\FiberBrowser.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "FiberBrowser ${VERSION}"
!define MUI_WELCOMEPAGE_TEXT "FiberBrowser shows Fiber-seq and DAF-seq footprints at single-molecule resolution.$\r$\n$\r$\nOn Windows it runs in WSL 2 (Windows Subsystem for Linux), in a Linux system of its own named FiberBrowser: Python, FiberHMM 3 and minimap2 come with it. Setup installs it for you ($INSTDIR); it does not change your other WSL distributions or settings.$\r$\n$\r$\nIf WSL is not installed yet, Setup offers to install it (administrator approval and usually a restart).$\r$\n$\r$\nClick Next to continue."
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${LICENSE}"
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\app\FiberBrowser.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Start FiberBrowser"
!define MUI_FINISHPAGE_TEXT "FiberBrowser is installed. Start it from the Start menu or the desktop shortcut; it opens in its own window.$\r$\n$\r$\nTip: pin FiberBrowser from the Start menu (not its running window) to the taskbar."
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Var PS
Var Code
Var RemoveData
Var SetupDir

!macro FIND_POWERSHELL
  ; The 64-bit PowerShell (Setup is 32-bit: System32 would be redirected, and
  ; a 32-bit PowerShell can't run wsl.exe).
  StrCpy $PS "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  IfFileExists "$PS" +2
    StrCpy $PS "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
!macroend

; Runs FiberBrowserSetup.ps1 (from $SetupDir) with the arguments in $0; its exit code in $Code.
!macro RUN_SETUP UN
Function ${UN}RunSetup
  nsExec::ExecToLog '"$PS" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$SetupDir\FiberBrowserSetup.ps1" $0'
  Pop $Code
  ${If} $Code == "error"
    StrCpy $Code 1
  ${EndIf}
FunctionEnd
!macroend
!insertmacro RUN_SETUP ""
!insertmacro RUN_SETUP "un."

Function .onInit
  !insertmacro FIND_POWERSHELL
FunctionEnd

Function un.onInit
  !insertmacro FIND_POWERSHELL
  StrCpy $SetupDir "$INSTDIR\app"
  StrCpy $RemoveData ""
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/REMOVEDATA" $R1
  ${IfNot} ${Errors}
    StrCpy $RemoveData "-RemoveData"
  ${EndIf}
FunctionEnd

Function ExplainFailure
  ${If} $Code == 20
    MessageBox MB_OK|MB_ICONSTOP "WSL 2 needs hardware virtualization, which is turned off on this PC.$\r$\n$\r$\nTurn on Intel VT-x / AMD-V (SVM) in the firmware (BIOS/UEFI) settings, then run Setup again. See https://aka.ms/enablevirtualization"
  ${ElseIf} $Code == 21
    MessageBox MB_OK|MB_ICONSTOP "WSL 2 needs the Windows feature 'Virtual Machine Platform'.$\r$\n$\r$\nRun Setup again and let it install WSL, or in an administrator terminal run: wsl --install --no-distribution, then restart Windows."
  ${ElseIf} $Code == 22
    MessageBox MB_OK|MB_ICONSTOP "WSL needs an update.$\r$\n$\r$\nIn a terminal run: wsl --update, then run Setup again."
  ${ElseIf} $Code == 31
    MessageBox MB_OK|MB_ICONSTOP "Your FiberBrowser data could not be backed up, so nothing was changed.$\r$\n$\r$\nDetails: $INSTDIR\logs\setup.log"
  ${Else}
    MessageBox MB_OK|MB_ICONSTOP "FiberBrowser could not be installed (code $Code).$\r$\n$\r$\nDetails: $INSTDIR\logs\setup.log"
  ${EndIf}
FunctionEnd

Section "FiberBrowser"
  SetShellVarContext current
  DeleteRegValue HKCU "${RUNONCE_KEY}" "FiberBrowserSetup"
  ; Setup's scripts run from a temporary copy: nothing is changed in $INSTDIR
  ; until WSL is ready and the distribution is imported.
  InitPluginsDir
  StrCpy $SetupDir "$PLUGINSDIR\app"
  SetOutPath "$SetupDir"
  File /x Uninstall.cmd "${APPDIR}\*.*"

  ; --- WSL 2 -----------------------------------------------------------------------
  DetailPrint "Checking WSL..."
  StrCpy $0 "-Action Check"
  Call RunSetup
  ${If} $Code != 0
    IfSilent 0 +3
      SetErrorLevel $Code
      Abort "WSL must already be available for a silent update."
    MessageBox MB_YESNO|MB_ICONINFORMATION "FiberBrowser runs in WSL 2 (Windows Subsystem for Linux), which is not installed on this PC or is too old.$\r$\n$\r$\nInstall it now? Windows asks for administrator approval, and may need a restart (Setup then continues after you sign in again).$\r$\n$\r$\nNo installs nothing; you can run Setup again later." IDYES install_wsl
    Abort "WSL 2 is needed: FiberBrowser was not installed."
  install_wsl:
    DetailPrint "Installing WSL (wsl --install --no-distribution, as administrator)..."
    ExecShellWait "runas" "$PS" '-NoProfile -ExecutionPolicy Bypass -File "$SetupDir\FiberBrowserSetup.ps1" -Action InstallWsl'
    StrCpy $0 "-Action Check"
    Call RunSetup
    ${If} $Code != 0
      WriteRegStr HKCU "${RUNONCE_KEY}" "FiberBrowserSetup" '"$EXEPATH"'
      MessageBox MB_OK|MB_ICONINFORMATION "Restart Windows to finish installing WSL.$\r$\n$\r$\nAfter you sign in again, FiberBrowser Setup starts by itself to finish (if WSL was not installed, run Setup again)."
      Abort "Restart Windows to finish installing WSL."
    ${EndIf}
  ${EndIf}

  ; --- the distribution ------------------------------------------------------------------
  SetOutPath "$PLUGINSDIR"
  DetailPrint "Unpacking FiberBrowser's Linux system..."
  SetCompress off
  File "/oname=rootfs.tar.gz" "${ROOTFS}"
  SetCompress auto
  StrCpy $R1 ""
  retry_install:
  StrCpy $0 '-Action Install -Tarball "$PLUGINSDIR\rootfs.tar.gz" -InstallDir "$INSTDIR" $R1'
  Call RunSetup
  ; An in-app /S update must never prompt, delete data, or report success on failure.
  ${If} $Code != 0
    IfSilent 0 +3
      SetErrorLevel $Code
      Abort "Silent update failed; previous data is kept. See logs/setup.log."
  ${EndIf}
  ${If} $Code == 40
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "FiberBrowser (or another FiberBrowser Setup) is running. Quit it (close its window), then click Retry." IDRETRY retry_install
    Abort "FiberBrowser is running."
  ${ElseIf} $Code == 30
    MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "There is not enough free disk space to keep your current FiberBrowser data (settings, sessions, downloaded genomes, files in its data folder) while it is updated.$\r$\n$\r$\nUpdate anyway and DELETE that data? (No: free some space and run Setup again.)" IDYES install_without_data
    Abort "Not enough disk space."
  install_without_data:
    StrCpy $R1 "-RemoveData"
    Goto retry_install
  ${ElseIf} $Code == 32
    MessageBox MB_OK|MB_ICONEXCLAMATION "FiberBrowser is installed, but your previous FiberBrowser data could not be restored into it. Nothing is lost: the backup is kept in $INSTDIR\UserData (details: $INSTDIR\logs\setup.log)."
  ${ElseIf} $Code != 0
    Call ExplainFailure
    Abort "FiberBrowser was not installed (code $Code)."
  ${EndIf}
  Delete "$PLUGINSDIR\rootfs.tar.gz"

  ; --- the app ---------------------------------------------------------------------------
  SetOutPath "$INSTDIR\app"
  File /x Uninstall.cmd "${APPDIR}\*.*"

  ; --- shortcuts and the uninstaller -----------------------------------------------------------
  SetOutPath "$INSTDIR\app"
  CreateShortCut "$SMPROGRAMS\FiberBrowser.lnk" "$INSTDIR\app\FiberBrowser.exe" "" "$INSTDIR\app\FiberBrowser.ico" 0
  CreateShortCut "$DESKTOP\FiberBrowser.lnk" "$INSTDIR\app\FiberBrowser.exe" "" "$INSTDIR\app\FiberBrowser.ico" 0
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${APP}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "FiberBrowser Authors"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "URLInfoAbout" "https://github.com/fiberseq/FiberBrowser"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\app\FiberBrowser.ico"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  ; The distribution's disk grows with use; this is the installed size.
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "EstimatedSize" 1100000
  DetailPrint "Done."
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  ${If} $RemoveData == ""
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete your FiberBrowser data: settings, saved sessions, the Library, downloaded genomes and the files in FiberBrowser's own data folder?$\r$\n$\r$\nNo keeps them in $INSTDIR\UserData; installing FiberBrowser again brings them back." /SD IDNO IDNO keep_data
    StrCpy $RemoveData "-RemoveData"
  keep_data:
  ${EndIf}
  retry_uninstall:
  StrCpy $0 '-Action Uninstall -InstallDir "$INSTDIR" $RemoveData'
  Call un.RunSetup
  ${If} $Code == 40
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "FiberBrowser (or FiberBrowser Setup) is running. Quit it (close its window), then click Retry." /SD IDCANCEL IDRETRY retry_uninstall
    Abort "FiberBrowser is running."
  ${ElseIf} $Code == 30
    MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "There is not enough free disk space to keep your FiberBrowser data.$\r$\n$\r$\nRemove FiberBrowser and DELETE that data? (No: free some space and try again.)" /SD IDNO IDYES uninstall_without_data
    Abort "Not enough disk space to keep your data."
  uninstall_without_data:
    StrCpy $RemoveData "-RemoveData"
    Goto retry_uninstall
  ${ElseIf} $Code != 0
    MessageBox MB_OK|MB_ICONSTOP "FiberBrowser's WSL distribution could not be removed (code $Code). Details: $INSTDIR\logs\setup.log" /SD IDOK
    Abort "FiberBrowser was not removed."
  ${EndIf}
  Delete "$SMPROGRAMS\FiberBrowser.lnk"
  Delete "$DESKTOP\FiberBrowser.lnk"
  RMDir /r "$INSTDIR\app"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR\distro"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  DeleteRegValue HKCU "${RUNONCE_KEY}" "FiberBrowserSetup"
SectionEnd
