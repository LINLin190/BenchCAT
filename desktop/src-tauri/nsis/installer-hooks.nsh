!macro NSIS_HOOK_POSTINSTALL
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

    ; Notify Explorer without clearing the user's pinned taskbar items.
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${EndIf}
!macroend
