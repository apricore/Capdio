!include "nsDialogs.nsh"
!include "LogicLib.nsh"

!ifndef BUILD_UNINSTALLER

Var CapdioLibraryPath
Var CapdioLibraryPathInput

!macro customInit
  StrCpy $CapdioLibraryPath "$APPDATA\Capdio\library"
!macroend

!macro customPageAfterChangeDir
  Page custom CapdioLibraryPage CapdioLibraryPageLeave
!macroend

Function CapdioLibraryPage
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 24u "Choose where Capdio stores imported media, captions, and manifest.json."
  Pop $0
  ${NSD_CreateText} 0 30u 78% 12u "$CapdioLibraryPath"
  Pop $CapdioLibraryPathInput
  ${NSD_CreateButton} 80% 30u 20% 12u "Browse..."
  Pop $0
  ${NSD_OnClick} $0 CapdioBrowseLibrary
  nsDialogs::Show
FunctionEnd

Function CapdioBrowseLibrary
  nsDialogs::SelectFolderDialog "Choose Capdio library folder" "$CapdioLibraryPath"
  Pop $0
  ${If} $0 != error
    StrCpy $CapdioLibraryPath $0
    ${NSD_SetText} $CapdioLibraryPathInput "$CapdioLibraryPath"
  ${EndIf}
FunctionEnd

Function CapdioLibraryPageLeave
  ${NSD_GetText} $CapdioLibraryPathInput $CapdioLibraryPath
  ${If} $CapdioLibraryPath == ""
    MessageBox MB_ICONEXCLAMATION "Choose a folder for the Capdio library."
    Abort
  ${EndIf}

  CreateDirectory "$CapdioLibraryPath"
  CreateDirectory "$APPDATA\Capdio"
  FileOpen $0 "$APPDATA\Capdio\library-path.txt" w
  FileWrite $0 "$CapdioLibraryPath"
  FileClose $0
FunctionEnd

!endif
