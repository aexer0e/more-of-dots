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
  SetOutPath "$INSTDIR"
  ; Remove the two files shipped by recorder 1.1.0's retired downloader.
  ; These are explicit deletes so upgrade cleanup never recursively follows a
  ; user-created junction or removes unrelated content.
  Delete "$INSTDIR\tools\depot-downloader\DepotDownloader.exe"
  Delete "$INSTDIR\tools\depot-downloader\DEPOTDOWNLOADER-LICENSE.txt"
  RMDir "$INSTDIR\tools\depot-downloader"
  RMDir "$INSTDIR\tools"
  Delete "$INSTDIR\install-recorder.ps1"
  File /r "${RECORDER_DIR}\*"
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
  SetOutPath "$LOCALAPPDATA\More of Dots Recorder\versions"
  File /r "${BUNDLED_VERSIONS_DIR}\*"
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
