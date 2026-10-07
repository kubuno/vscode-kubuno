# Screenshots of the designer, the Toolbox and Properties on Windows:
#   powershell -File scripts\demo-windows.ps1 -Out captures -Which waffle [-Ls C:\path\kubuno-views-ls.exe] [-Code C:\path\Code.exe]
# Runs the integration tests with the demo layout kept open, then captures the VS Code window with PrintWindow
# (PW_RENDERFULLCONTENT, so the GPU-composited webviews are included and no other window can cover it).
param(
  [string]$Out = 'captures',
  [string]$Which = 'waffle',
  [string]$Ls = '',
  [string]$Code = ''
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $Out | Out-Null
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class KbWin {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
[KbWin]::SetProcessDPIAware() | Out-Null   # physical pixels: the window rectangle and PrintWindow agree at any scale
$env:KUBUNO_DEMO = '25'
$env:KUBUNO_DEMO_FILE = $Which
if ($Ls) { $env:KUBUNO_VIEWS_LS = $Ls }
if ($Code) { $env:KUBUNO_VSCODE = $Code }
$start = Get-Date
$log = Join-Path $Out "run-windows-$Which.log"
$p = Start-Process -FilePath node -ArgumentList 'out/test/runTest.js' -NoNewWindow -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
$ready = $null
for ($i = 0; $i -lt 600 -and -not $ready; $i++) {
  $ready = Get-ChildItem "$env:TEMP\kubuno-vscode-ws-*\demo-ready" -ErrorAction SilentlyContinue | Where-Object LastWriteTime -gt $start | Select-Object -First 1
  if (-not $ready) { Start-Sleep -Milliseconds 500 }
}
Start-Sleep -Seconds 4
$w = Get-Process | Where-Object { $_.MainWindowTitle -like '*Extension Development Host*' } | Select-Object -First 1
if (-not $w) { throw 'VS Code window not found' }
[KbWin]::ShowWindow($w.MainWindowHandle, 3) | Out-Null   # maximised
Start-Sleep -Seconds 3
$r = New-Object KbWin+RECT
[KbWin]::GetWindowRect($w.MainWindowHandle, [ref]$r) | Out-Null
$bmp = New-Object System.Drawing.Bitmap ($r.Right - $r.Left), ($r.Bottom - $r.Top)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$dc = $g.GetHdc()
[KbWin]::PrintWindow($w.MainWindowHandle, $dc, 2) | Out-Null
$g.ReleaseHdc($dc)
$file = Join-Path (Resolve-Path $Out) "windows-$Which.png"
$bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
"captured $file"
$p.WaitForExit()
