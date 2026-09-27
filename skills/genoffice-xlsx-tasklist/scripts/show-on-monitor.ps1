# Move the GenOffice window that shows a taskboard to monitor N and maximize it.
# Numbering: 1 = primary display, then the other displays left to right, top to bottom (stable across reboots, unlike DISPLAYn order).
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File show-on-monitor.ps1 -Monitor 2 [-TitleLike '*TASKS*'] [-List]
param([int]$Monitor = 2, [string]$TitleLike = '*', [switch]$List)
Add-Type -AssemblyName System.Windows.Forms
if (-not ('TaskboardWin' -as [type])) {
Add-Type @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class TaskboardWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public static List<IntPtr> Windows() { var r = new List<IntPtr>(); EnumWindows((h, l) => { if (IsWindowVisible(h)) r.Add(h); return true; }, IntPtr.Zero); return r; }
  public static string Title(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
}
'@
}
$screens = @([System.Windows.Forms.Screen]::AllScreens | Sort-Object @{ Expression = { -not $_.Primary } }, @{ Expression = { $_.Bounds.X } }, @{ Expression = { $_.Bounds.Y } })
$i = 0
$mon = $screens | ForEach-Object { $i++; [pscustomobject]@{ Monitor = $i; Device = $_.DeviceName; Primary = $_.Primary; X = $_.Bounds.X; Y = $_.Bounds.Y; Width = $_.Bounds.Width; Height = $_.Bounds.Height } }
$pids = @(Get-Process -Name GenOffice -ErrorAction SilentlyContinue | ForEach-Object Id)
$wins = foreach ($h in [TaskboardWin]::Windows()) {
  $p = 0; [void][TaskboardWin]::GetWindowThreadProcessId($h, [ref]$p)
  $t = [TaskboardWin]::Title($h)
  if ($pids -contains [int]$p -and $t -and $t -like $TitleLike) { [pscustomobject]@{ Handle = $h; Pid = $p; Title = $t } }
}
if ($List) { $mon | Format-Table -AutoSize | Out-String; $wins | Format-Table Pid, Title -AutoSize | Out-String; return }
if ($Monitor -lt 1 -or $Monitor -gt $screens.Count) { throw "Monitor $Monitor not present; $($screens.Count) monitor(s) detected. Use -List." }
if (-not $wins) { throw "No visible GenOffice window matching '$TitleLike'. Open the board first (board-engine publishes and opens it)." }
$w = @($wins)[0]
$b = $screens[$Monitor - 1].WorkingArea
[void][TaskboardWin]::ShowWindow($w.Handle, 9)
[void][TaskboardWin]::SetWindowPos($w.Handle, [IntPtr]::Zero, $b.X, $b.Y, $b.Width, $b.Height, 0x0040)
[void][TaskboardWin]::ShowWindow($w.Handle, 3)
[void][TaskboardWin]::SetForegroundWindow($w.Handle)
[pscustomobject]@{ status = 'ok'; monitor = $Monitor; device = $screens[$Monitor - 1].DeviceName; title = $w.Title; pid = $w.Pid } | ConvertTo-Json -Compress
