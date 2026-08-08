Unicode true
!include "MUI2.nsh"

!ifndef RECORDER_DIR
  !error "RECORDER_DIR is required"
!endif
!ifndef OUTPUT_PATH
  !error "OUTPUT_PATH is required"
!endif
!ifndef PRODUCT_VERSION
  !error "PRODUCT_VERSION is required"
!endif
!ifndef BUNDLED_VERSIONS_DIR
  !error "BUNDLED_VERSIONS_DIR is required"
!endif
!ifndef BUNDLED_VERSIONS_ID
  !error "BUNDLED_VERSIONS_ID is required"
!endif
!ifndef BUNDLED_VERSIONS_PROBE
  !error "BUNDLED_VERSIONS_PROBE is required"
!endif

; Silent-install exit codes. The app reports these back to the user, so they must
; stay distinguishable from NSIS's own failures.
!define ERR_RECORDER_RUNNING 3
!define ERR_INSTALL_INCOMPLETE 4

Name "More of Dots Recorder"
OutFile "${OUTPUT_PATH}"
InstallDir "$LOCALAPPDATA\Programs\More of Dots Recorder"
RequestExecutionLevel user
SetCompressor /SOLID lzma
Icon "..\src-tauri\icons\icon.ico"
UninstallIcon "..\src-tauri\icons\icon.ico"
VIProductVersion "${PRODUCT_VERSION}.0"
VIAddVersionKey /LANG=1033 "ProductName" "More of Dots Recorder"
VIAddVersionKey /LANG=1033 "CompanyName" "More of Dots"
VIAddVersionKey /LANG=1033 "FileDescription" "More of Dots Replay Recorder Installer"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Copyright 2026 More of Dots contributors"
VIAddVersionKey /LANG=1033 "FileVersion" "${PRODUCT_VERSION}"
VIAddVersionKey /LANG=1033 "ProductVersion" "${PRODUCT_VERSION}"

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_NOAUTOCLOSE
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\More of Dots Recorder"
FunctionEnd

Function un.onInit
  StrCmp $INSTDIR "$LOCALAPPDATA\Programs\More of Dots Recorder" valid_install_dir
  MessageBox MB_ICONSTOP "The recorder uninstaller is not in its expected installation folder and will not continue."
  Abort
  valid_install_dir:
FunctionEnd

Section "Recorder" SEC_RECORDER
  SetShellVarContext current

  ; A recording in flight holds an open image handle on the recorder executable,
  ; and NSIS cannot overwrite it. Probe for the lock first so a silent upgrade
  ; fails with a code the app can explain instead of a half-written install.
  IfFileExists "$INSTDIR\more-of-dots-recorder.exe" 0 recorder_not_running
    ClearErrors
    FileOpen $R0 "$INSTDIR\more-of-dots-recorder.exe" a
    IfErrors 0 recorder_unlocked
      ; Quit rather than Abort: Abort forces error level 2 and would erase the
      ; specific code the app needs to explain what went wrong.
      SetErrorLevel ${ERR_RECORDER_RUNNING}
      Quit
    recorder_unlocked:
      FileClose $R0
  recorder_not_running:

  SetOutPath "$INSTDIR"
  ; Remove the two files shipped by recorder 1.1.0's retired downloader.
  ; These are explicit deletes so upgrade cleanup never recursively follows a
  ; user-created junction or removes unrelated content.
  Delete "$INSTDIR\tools\depot-downloader\DepotDownloader.exe"
  Delete "$INSTDIR\tools\depot-downloader\DEPOTDOWNLOADER-LICENSE.txt"
  RMDir "$INSTDIR\tools\depot-downloader"
  RMDir "$INSTDIR\tools"
  Delete "$INSTDIR\install-recorder.ps1"

  ; PyInstaller renames payload files between builds, so overwriting in place
  ; leaves orphaned modules behind that later builds may still import. Clearing
  ; the payload directory is safe because it only ever holds installer-owned
  ; files; the bundled game vault lives outside $INSTDIR.
  RMDir /r "$INSTDIR\payload"

  File /r "${RECORDER_DIR}\*"

  ; Silent installs skip the file-error dialog, so confirm the payload landed
  ; rather than trusting NSIS's default exit code.
  IfFileExists "$INSTDIR\more-of-dots-recorder.exe" 0 recorder_incomplete
  IfFileExists "$INSTDIR\payload\*.*" recorder_complete
  recorder_incomplete:
    SetErrorLevel ${ERR_INSTALL_INCOMPLETE}
    Quit
  recorder_complete:

  WriteUninstaller "$INSTDIR\Uninstall More of Dots Recorder.exe"

  CreateDirectory "$SMPROGRAMS\More of Dots Recorder"
  CreateShortcut "$SMPROGRAMS\More of Dots Recorder\Inspect bundled versions.lnk" "$WINDIR\explorer.exe" '"$LOCALAPPDATA\More of Dots Recorder\versions"'
  CreateShortcut "$SMPROGRAMS\More of Dots Recorder\Uninstall More of Dots Recorder.lnk" "$INSTDIR\Uninstall More of Dots Recorder.exe"

  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MoreOfDotsRecorder" "DisplayName" "More of Dots Recorder"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MoreOfDotsRecorder" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MoreOfDotsRecorder" "Publisher" "More of Dots"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MoreOfDotsRecorder" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MoreOfDotsRecorder" "DisplayIcon" "$INSTDIR\more-of-dots-recorder.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MoreOfDotsRecorder" "UninstallString" '"$INSTDIR\Uninstall More of Dots Recorder.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MoreOfDotsRecorder" "QuietUninstallString" '"$INSTDIR\Uninstall More of Dots Recorder.exe" /S'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MoreOfDotsRecorder" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MoreOfDotsRecorder" "NoRepair" 1
SectionEnd

Section "Bundled replay game versions" SEC_BUNDLED_VERSIONS
  SetShellVarContext current
  ; The vault is roughly half a gigabyte and is by far the slowest part of the
  ; install, yet it only changes when a new game build is bundled. The marker
  ; records the content hash already on disk so payload-only upgrades skip it.
  StrCpy $R1 "$LOCALAPPDATA\More of Dots Recorder\versions\.bundled-id"
  ; The marker alone is not enough. A user who deleted the vault by hand would
  ; otherwise keep a stale marker and never get the game data back.
  IfFileExists "$LOCALAPPDATA\More of Dots Recorder\versions\${BUNDLED_VERSIONS_PROBE}\game\game.exe" 0 extract_versions
  ClearErrors
  FileOpen $R2 "$R1" r
  IfErrors extract_versions
  FileRead $R2 $R3
  FileClose $R2
  StrCmp $R3 "${BUNDLED_VERSIONS_ID}" versions_current extract_versions

  extract_versions:
    SetOutPath "$LOCALAPPDATA\More of Dots Recorder\versions"
    Delete "$R1"
    File /r "${BUNDLED_VERSIONS_DIR}\*"
    ClearErrors
    FileOpen $R2 "$R1" w
    IfErrors versions_current
    FileWrite $R2 "${BUNDLED_VERSIONS_ID}"
    FileClose $R2
  versions_current:
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  Delete "$SMPROGRAMS\More of Dots Recorder\Inspect bundled versions.lnk"
  Delete "$SMPROGRAMS\More of Dots Recorder\Uninstall More of Dots Recorder.lnk"
  RMDir "$SMPROGRAMS\More of Dots Recorder"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MoreOfDotsRecorder"
  RMDir /r "$INSTDIR"
  ; Bundled game versions intentionally remain in the recorder vault so a
  ; quarantined recorder executable can be reinstalled without losing them.
SectionEnd
