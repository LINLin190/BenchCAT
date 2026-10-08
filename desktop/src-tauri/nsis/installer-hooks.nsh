!macro NSIS_HOOK_POSTINSTALL
  ; Add an XML verb without changing the user's default XML application.
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.xml\shell\BenchCAT.EepromFlash" "" "烧录EEPROM"
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.xml\shell\BenchCAT.EepromFlash" "Icon" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0'
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.xml\shell\BenchCAT.EepromFlash" "MultiSelectModel" "Single"
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.xml\shell\BenchCAT.EepromFlash\command" "" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" --quick-flash $\"%1$\"'
  ${If} $UpdateMode = 1
    ; Recreate the default desktop shortcut so an in-place update refreshes its icon.
    IfFileExists "$DESKTOP\${PRODUCTNAME}.lnk" 0 refresh_desktop_done
      Delete "$DESKTOP\${PRODUCTNAME}.lnk"
      CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
    refresh_desktop_done:

    ; Refresh the default Start Menu shortcut when it exists.
    IfFileExists "$SMPROGRAMS\${PRODUCTNAME}.lnk" 0 refresh_start_menu_done
      Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
      CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    refresh_start_menu_done:

  ${EndIf}
  ; Notify Explorer after registering the verb and refreshing shortcuts.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    DeleteRegKey SHCTX "Software\Classes\SystemFileAssociations\.xml\shell\BenchCAT.EepromFlash"
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${EndIf}
!macroend
