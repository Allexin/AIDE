# Put an AIDE window at the top-left corner with a 1920x1080 logical size.
#   powershell -NoProfile -ExecutionPolicy Bypass -File site/tools/aide-window.ps1 [-Title "*UEMetaProject*"]
# Windows are found by title among all top-level windows (one Electron process
# owns several). The size is scaled by the window's DPI, so at 150% the window
# is 2880x1620 physical pixels and the shot shows the same layout as at 100%;
# to-webp.py scales it back to 1920 wide.
param([string]$Title = 'AIDE*UEMetaProject*', [int]$Width = 1920, [int]$Height = 1080)

Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class Win {
    public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder sb, int max);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
    [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hwnd, int x, int y, int w, int h, bool repaint);
    public static List<KeyValuePair<IntPtr, string>> Visible() {
        var list = new List<KeyValuePair<IntPtr, string>>();
        EnumWindows((h, l) => {
            if (!IsWindowVisible(h)) return true;
            var sb = new StringBuilder(512);
            GetWindowText(h, sb, sb.Capacity);
            if (sb.Length > 0) list.Add(new KeyValuePair<IntPtr, string>(h, sb.ToString()));
            return true;
        }, IntPtr.Zero);
        return list;
    }
}
'@
[Win]::SetProcessDPIAware() | Out-Null

$windows = [Win]::Visible() | Where-Object { $_.Value -like $Title }
if (-not $windows) { throw "No window titled '$Title'" }
foreach ($w in $windows) {
    $scale = [Win]::GetDpiForWindow($w.Key) / 96.0
    $pw = [int]($Width * $scale); $ph = [int]($Height * $scale)
    [Win]::ShowWindow($w.Key, 9) | Out-Null   # SW_RESTORE: a maximized window ignores MoveWindow
    [Win]::MoveWindow($w.Key, 0, 0, $pw, $ph, $true) | Out-Null
    Write-Host "$($w.Value): ${pw}x${ph} physical (scale $scale)"
}
