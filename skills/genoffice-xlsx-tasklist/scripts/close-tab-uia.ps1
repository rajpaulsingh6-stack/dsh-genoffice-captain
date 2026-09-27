# Close exactly one GenOffice tab by clicking its own "Close tab" button through Windows UI Automation.
# No keystrokes, no focus change. If GenOffice asks about unsaved changes, answer the dialog the same way.
# Usage: close-tab-uia.ps1 -GuiPid <pid> -Title <file name shown on the tab> [-Answer DontSave|Save|Cancel]
param([Parameter(Mandatory = $true)][int]$GuiPid, [Parameter(Mandatory = $true)][string]$Title, [ValidateSet('DontSave', 'Save', 'Cancel')][string]$Answer = 'DontSave')
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
if (-not ('GxtFg2' -as [type])) {
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class GxtFg2 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
'@
}
$prevFg = [GxtFg2]::GetForegroundWindow()
function Restore-Focus {
  $cur = [GxtFg2]::GetForegroundWindow(); $cp = 0; [void][GxtFg2]::GetWindowThreadProcessId($cur, [ref]$cp)
  if ($cp -ne $GuiPid -or $prevFg -eq $cur -or -not [GxtFg2]::IsWindow($prevFg)) { return }
  $t = [GxtFg2]::GetWindowThreadProcessId($cur, [IntPtr]::Zero); $me = [GxtFg2]::GetCurrentThreadId()
  [void][GxtFg2]::AttachThreadInput($me, $t, $true); [void][GxtFg2]::SetForegroundWindow($prevFg); [void][GxtFg2]::AttachThreadInput($me, $t, $false)
}
$A = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
function Cond($prop, $val) { New-Object System.Windows.Automation.PropertyCondition($prop, $val) }
function Invoke($el) { $ip = $null; if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$ip)) { $ip.Invoke(); return $true }; return $false }
$win = $A::RootElement.FindAll($TS::Children, (Cond $A::ProcessIdProperty $GuiPid)) | Where-Object { $_.Current.ClassName -eq 'Chrome_WidgetWin_1' } | Select-Object -First 1
if (-not $win) { '{"closed":false,"error":"GenOffice window not found"}'; exit 3 }
$texts = @($win.FindAll($TS::Descendants, (Cond $A::NameProperty $Title)) | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text })
if ($texts.Count -ne 1) { '{"closed":false,"error":"' + $texts.Count + ' tabs titled ' + $Title.Replace('"', "'") + '; refusing to guess"}'; exit 3 }
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$tab = $walker.GetParent($texts[0]); $btn = $null
for ($i = 0; $i -lt 3 -and $tab -and -not $btn; $i++) { $btn = $tab.FindFirst($TS::Descendants, (Cond $A::NameProperty 'Close tab')); if (-not $btn) { $tab = $walker.GetParent($tab) } }
if (-not $btn) { '{"closed":false,"error":"close button for the tab not found"}'; exit 3 }
if (-not (Invoke $btn)) { '{"closed":false,"error":"close button cannot be invoked"}'; exit 3 }
$answered = 'none'
for ($i = 0; $i -lt 12; $i++) {
  Start-Sleep -Milliseconds 250
  $dlg = $win.FindFirst($TS::Descendants, (Cond $A::ClassNameProperty '#32770'))
  if ($dlg) {
    $name = @{ DontSave = "Don't Save"; Save = 'Save'; Cancel = 'Cancel' }[$Answer]
    $b = $dlg.FindFirst($TS::Descendants, (Cond $A::NameProperty $name))
    if ($b -and (Invoke $b)) { $answered = $Answer } else { $answered = 'dialog-unanswered' }
    break
  }
}
Start-Sleep -Milliseconds 200
Restore-Focus
'{"closed":true,"method":"ui-automation close-tab button","dialog":"' + $answered + '"}'
