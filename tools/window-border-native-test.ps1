# Hidden fixture windows only. Never change an existing DSH or other app window.
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Version.Build -lt 22000) { throw 'Native checks require Windows 11' }
Add-Type -Path (Join-Path $PSScriptRoot '../scripts/window-border.cs')
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace DshBackground {
  public static class BorderFixture {
    delegate IntPtr WndProc(IntPtr h, uint message, IntPtr w, IntPtr l);
    static WndProc proc = DefWindowProc;
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct WindowClass {
      public uint style; public WndProc proc; public int clsExtra, wndExtra;
      public IntPtr instance, icon, cursor, background;
      public string menu, name;
    }
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern ushort RegisterClass(ref WindowClass c);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr CreateWindowEx(uint ex,string c,string t,uint style,int x,int y,int w,int h,IntPtr p,IntPtr menu,IntPtr instance,IntPtr data);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr DefWindowProc(IntPtr h,uint m,IntPtr w,IntPtr l);
    [DllImport("user32.dll")] public static extern bool DestroyWindow(IntPtr h);
    public static IntPtr Create(string c,string t,IntPtr parent) {
      WindowClass wc=new WindowClass(); wc.proc=proc; wc.name=c; RegisterClass(ref wc);
      IntPtr h=CreateWindowEx(0,c,t,0x00cf0000,0,0,320,200,parent,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero);
      if(h==IntPtr.Zero)throw new Exception("Fixture window failed"); return h;
    }
  }
}
'@
$taskWindows = @()
$taskChecks = 0
function Assert-Equal($Actual,$Expected,$Label) {
  if ($Actual -ne $Expected) { throw ($Label + ': expected ' + $Expected + ', got ' + $Actual) }
  $script:taskChecks++; Write-Output ('PASS ' + $Label)
}
try {
  $taskMain = [DshBackground.BorderFixture]::Create('Chrome_WidgetWin_1','Fixture - DeepSeek Harness',[IntPtr]::Zero); $taskWindows += $taskMain
  $taskOther = [DshBackground.BorderFixture]::Create('Chrome_WidgetWin_1','Another application',[IntPtr]::Zero); $taskWindows += $taskOther
  $taskClass = [DshBackground.BorderFixture]::Create('BgOtherWidget','Fixture - DeepSeek Harness',[IntPtr]::Zero); $taskWindows += $taskClass
  $taskOwned = [DshBackground.BorderFixture]::Create('Chrome_WidgetWin_1','Dialog - DeepSeek Harness',$taskMain); $taskWindows += $taskOwned
  $taskPolicy = New-Object DshBackground.WindowBorder($PID)
  try {
    $taskPolicy.Update($true)
    Assert-Equal $taskPolicy.Count 1 'DWM accepts border removal on main window'
    Assert-Equal $taskPolicy.Targets[0] $taskMain 'only matching unowned main window targeted'
    Assert-Equal $taskPolicy.Writes 1 'other title, class and owned dialog untouched'
    for($taskI=0;$taskI -lt 100;$taskI++){ $taskPolicy.Update($true) }
    Assert-Equal $taskPolicy.Writes 1 'repeated updates avoid repeated DWM writes'
    $taskPolicy.Update($false)
    Assert-Equal $taskPolicy.Count 0 'disable removes native policy'
    Assert-Equal $taskPolicy.RestoreFailures 0 'DWM accepts system default restoration'
    $taskPolicy.Update($true); $taskPolicy.Dispose()
    Assert-Equal $taskPolicy.Count 0 'dispose removes native policy'
    Assert-Equal $taskPolicy.RestoreFailures 0 'dispose restores system default successfully'
    $taskPolicy.Dispose(); Assert-Equal $taskPolicy.RestoreFailures 0 'repeat disposal safe'
    $taskWrongOwner = New-Object DshBackground.WindowBorder(2147483647); $taskWrongOwner.Update($true)
    Assert-Equal $taskWrongOwner.Count 0 'foreign process windows never targeted'
    $taskWrongOwner.Dispose()
    $taskPolicy.Update($true); [DshBackground.BorderFixture]::DestroyWindow($taskMain) | Out-Null
    $taskPolicy.Update($true); Assert-Equal $taskPolicy.Count 0 'closed windows removed safely'
  } finally { $taskPolicy.Dispose() }
  Write-Output ($taskChecks.ToString() + ' isolated native DWM checks passed')
} finally {
  foreach($taskWindow in $taskWindows) { [DshBackground.BorderFixture]::DestroyWindow($taskWindow) | Out-Null }
}
