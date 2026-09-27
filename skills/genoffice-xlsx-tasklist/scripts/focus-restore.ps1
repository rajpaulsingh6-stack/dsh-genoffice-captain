# Give keyboard focus back to the window the user was using (no synthetic keys).
# Usage: focus-restore.ps1 -Get  -> prints the current foreground window handle; focus-restore.ps1 -Hwnd <handle>
param([switch]$Get, [long]$Hwnd = 0)
if (-not ('GxtFg' -as [type])) {
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class GxtFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
'@
}
if ($Get) { [GxtFg]::GetForegroundWindow().ToInt64(); exit 0 }
$h = [IntPtr]$Hwnd
if ($Hwnd -eq 0 -or -not [GxtFg]::IsWindow($h)) { exit 0 }
$fgThread = [GxtFg]::GetWindowThreadProcessId([GxtFg]::GetForegroundWindow(), [IntPtr]::Zero)
$me = [GxtFg]::GetCurrentThreadId()
[void][GxtFg]::AttachThreadInput($me, $fgThread, $true)
[void][GxtFg]::SetForegroundWindow($h)
[void][GxtFg]::AttachThreadInput($me, $fgThread, $false)
