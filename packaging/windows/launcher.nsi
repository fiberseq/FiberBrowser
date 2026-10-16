; FiberBrowser.exe: what the Start-menu and desktop shortcuts start. It runs
; the launcher script (FiberBrowser.ps1, next to it) with Windows PowerShell,
; hidden: nsExec starts it without a console window, so no window flashes.
; An NSIS "installer" with nothing to install (SilentInstall), because makensis
; builds it on macOS/Linux too; built by build_installer.sh:
;   makensis -DOUTFILE=FiberBrowser.exe -DICON=FiberBrowser.ico -DVERSION=3.0.0 launcher.nsi
Unicode true
!ifndef OUTFILE
  !define OUTFILE "FiberBrowser.exe"
!endif
!ifndef VERSION
  !define VERSION "0.0.0"
!endif
Name "FiberBrowser"
OutFile "${OUTFILE}"
Icon "${ICON}"
RequestExecutionLevel user
SilentInstall silent
SetCompressor /SOLID lzma
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "FiberBrowser"
VIAddVersionKey "FileDescription" "FiberBrowser"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "FiberBrowser Authors"
VIAddVersionKey "LegalCopyright" "MIT License"

!include "FileFunc.nsh"

Section
  ; The 64-bit PowerShell (this program is 32-bit: System32 would be redirected).
  StrCpy $0 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  IfFileExists "$0" +2
    StrCpy $0 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  ${GetParameters} $1
  nsExec::Exec '"$0" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Sta -File "$EXEDIR\FiberBrowser.ps1" $1'
  Pop $2
  StrCmp $2 "error" 0 +3
    MessageBox MB_OK|MB_ICONSTOP "FiberBrowser could not start Windows PowerShell ($0)."
    SetErrorLevel 1
SectionEnd
