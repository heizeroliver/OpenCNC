param(
  [Parameter(Mandatory = $true)][string]$RequestPath,
  [Parameter(Mandatory = $true)][string]$ResultPath
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
$editorPath = "C:\Biesse\BiesseWorks\Editor\Editor.exe"
$utf8 = New-Object System.Text.UTF8Encoding($false)
$openedCount = 0
$total = 0

function Write-BridgeStatus {
  param([string]$State, [int]$Current, [string]$FileName = "", [string]$Message = "")
  $value = [ordered]@{
    schemaVersion = 1
    state = $State
    current = $Current
    total = $total
    openedCount = $openedCount
  }
  if ($FileName) { $value.fileName = $FileName }
  if ($Message) { $value.message = $Message }
  $temporary = "$ResultPath.$([Guid]::NewGuid().ToString('N')).tmp"
  [System.IO.File]::WriteAllText($temporary, ($value | ConvertTo-Json -Compress), $utf8)
  if (Test-Path -LiteralPath $ResultPath) { [System.IO.File]::Replace($temporary, $ResultPath, $null) }
  else { [System.IO.File]::Move($temporary, $ResultPath) }
}

try {
  $request = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($request.schemaVersion -ne 1 -or $null -eq $request.outputs) { throw "Invalid OpenCNC BiesseWorks bridge request" }
  $outputs = @($request.outputs)
  $total = $outputs.Count
  if ($total -lt 1) { throw "The BiesseWorks bridge request contains no files" }
  if (-not (Test-Path -LiteralPath $editorPath -PathType Leaf)) { throw "BiesseWorks Editor was not found at $editorPath" }

  foreach ($output in $outputs) {
    if (-not $output.name -or -not $output.path -or $output.path -notlike "*.bpp") { throw "The bridge request contains an invalid BPP path" }
    if (-not (Test-Path -LiteralPath $output.path -PathType Leaf)) { throw "BPP file is missing: $($output.name)" }
    $actual = (Get-FileHash -LiteralPath $output.path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne ([string]$output.checksum).ToLowerInvariant()) { throw "BPP file changed after OpenCNC verification: $($output.name)" }
  }

  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class OpenCncBiesseWindows {
    private delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder value, int maximum);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetDlgItem(IntPtr dialog, int identifier);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool SetWindowText(IntPtr window, string value);
    [DllImport("user32.dll")] private static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    public static bool Activate(IntPtr window) {
        ShowWindow(window, 9);
        return SetForegroundWindow(window);
    }

    public static IntPtr FindFileDialog(int processId) {
        IntPtr result = IntPtr.Zero;
        EnumWindows(delegate(IntPtr window, IntPtr parameter) {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner != (uint)processId || !IsWindowVisible(window)) return true;
            StringBuilder name = new StringBuilder(64);
            GetClassName(window, name, name.Capacity);
            if (name.ToString() != "#32770" || GetDlgItem(window, 1148) == IntPtr.Zero) return true;
            result = window;
            return false;
        }, IntPtr.Zero);
        return result;
    }

    public static bool SubmitFile(IntPtr dialog, string path) {
        IntPtr fileName = GetDlgItem(dialog, 1148);
        IntPtr openButton = GetDlgItem(dialog, 1);
        if (fileName == IntPtr.Zero || openButton == IntPtr.Zero) return false;
        if (!SetWindowText(fileName, path)) return false;
        SendMessage(openButton, 0x00F5, IntPtr.Zero, IntPtr.Zero);
        return true;
    }
}
'@

  function Find-BiesseEditor {
    foreach ($candidate in @(Get-Process -Name "Editor" -ErrorAction SilentlyContinue)) {
      try {
        if ($candidate.Path -and [StringComparer]::OrdinalIgnoreCase.Equals([System.IO.Path]::GetFullPath($candidate.Path), $editorPath)) { return $candidate }
      } catch { }
    }
    return $null
  }

  Write-BridgeStatus -State "starting" -Current 0
  $editor = Find-BiesseEditor
  if ($null -eq $editor) {
    Start-Process -FilePath $editorPath -WorkingDirectory (Split-Path -Parent $editorPath) | Out-Null
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  do {
    Start-Sleep -Milliseconds 250
    $editor = Find-BiesseEditor
    if ($null -ne $editor) { $editor.Refresh() }
  } while (($null -eq $editor -or $editor.MainWindowHandle -eq 0) -and [DateTime]::UtcNow -lt $deadline)
  if ($null -eq $editor -or $editor.MainWindowHandle -eq 0) { throw "BiesseWorks Editor did not become ready within 60 seconds" }

  $automationShell = New-Object -ComObject WScript.Shell
  for ($index = 0; $index -lt $outputs.Count; $index += 1) {
    $output = $outputs[$index]
    Write-BridgeStatus -State "opening" -Current ($index + 1) -FileName ([string]$output.name)
    $editor.Refresh()
    [OpenCncBiesseWindows]::Activate($editor.MainWindowHandle) | Out-Null
    $automationShell.AppActivate($editor.Id) | Out-Null
    Start-Sleep -Milliseconds 250
    [System.Windows.Forms.SendKeys]::SendWait("^o")

    $dialog = [IntPtr]::Zero
    $dialogDeadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
      Start-Sleep -Milliseconds 100
      $dialog = [OpenCncBiesseWindows]::FindFileDialog($editor.Id)
    } while ($dialog -eq [IntPtr]::Zero -and [DateTime]::UtcNow -lt $dialogDeadline)
    if ($dialog -eq [IntPtr]::Zero) { throw "BiesseWorks did not open its File > Open dialog for $($output.name)" }
    if (-not [OpenCncBiesseWindows]::SubmitFile($dialog, [string]$output.path)) { throw "OpenCNC could not enter $($output.name) in the BiesseWorks file dialog" }

    $loadDeadline = [DateTime]::UtcNow.AddSeconds(60)
    while ([OpenCncBiesseWindows]::IsWindow($dialog) -and [DateTime]::UtcNow -lt $loadDeadline) { Start-Sleep -Milliseconds 150 }
    if ([OpenCncBiesseWindows]::IsWindow($dialog)) { throw "BiesseWorks did not finish opening $($output.name) within 60 seconds" }
    $openedCount += 1
    Start-Sleep -Milliseconds 500
  }

  Write-BridgeStatus -State "completed" -Current $total -Message "$openedCount BPP file(s) opened in BiesseWorks"
  exit 0
} catch {
  try { Write-BridgeStatus -State "failed" -Current $openedCount -Message $_.Exception.Message } catch { }
  exit 1
}
