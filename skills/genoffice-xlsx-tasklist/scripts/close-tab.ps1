# Retired in GenOffice_XLSX_Tasklist 1.2: keystroke tab closing could steal the user's typing.
# The engine now closes tabs with close-tab-uia.ps1 (UI Automation click on the tab's own Close button).
Write-Output 'close-tab.ps1 is retired; use close-tab-uia.ps1'
exit 3
