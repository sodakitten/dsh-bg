# Compile an isolated fake Desktop parent. All windows are invisible fixtures.
param([string]$NodePath='node.exe')
$ErrorActionPreference='Stop'
$taskScratch=[IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ('dsh-bg-border-parent-'+[Guid]::NewGuid().ToString('N'))))
$null=New-Item -ItemType Directory -Path $taskScratch
try {
  $taskExe=Join-Path $taskScratch 'DeepSeek Harness.exe'
  Add-Type -OutputAssembly $taskExe -OutputType ConsoleApplication -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
namespace BorderHelperFixture {
  static class Program {
    delegate IntPtr WndProc(IntPtr h,uint m,IntPtr w,IntPtr l);
    static WndProc proc=DefWindowProc;
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct WindowClass {
      public uint style; public WndProc proc; public int clsExtra,wndExtra;
      public IntPtr instance,icon,cursor,background; public string menu,name;
    }
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern ushort RegisterClass(ref WindowClass c);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr CreateWindowEx(uint ex,string c,string t,uint style,int x,int y,int w,int h,IntPtr p,IntPtr menu,IntPtr instance,IntPtr data);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr DefWindowProc(IntPtr h,uint m,IntPtr w,IntPtr l);
    [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr h);
    public static int Main(string[] args) {
      WindowClass wc=new WindowClass();wc.proc=proc;wc.name="Chrome_WidgetWin_1";RegisterClass(ref wc);
      IntPtr h=CreateWindowEx(0,wc.name,"Helper fixture - DeepSeek Harness",0x00cf0000,0,0,320,200,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero);
      if(h==IntPtr.Zero)return 2;
      try {
        var start=new ProcessStartInfo(args[0],"\""+args[1]+"\"");
        start.UseShellExecute=false;start.CreateNoWindow=true;start.RedirectStandardOutput=true;start.RedirectStandardError=true;
        using(var child=Process.Start(start)) {
          string output=child.StandardOutput.ReadToEnd(), error=child.StandardError.ReadToEnd();
          child.WaitForExit();Console.Write(output);Console.Error.Write(error);return child.ExitCode;
        }
      } finally {DestroyWindow(h);}
    }
  }
}
'@
  $taskStart=New-Object Diagnostics.ProcessStartInfo
  $taskStart.FileName=$taskExe
  $taskScript=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'window-border-helper-test.mjs'))
  $taskStart.Arguments='"'+$NodePath+'" "'+$taskScript+'"'
  $taskStart.UseShellExecute=$false; $taskStart.CreateNoWindow=$true
  $taskStart.RedirectStandardOutput=$true; $taskStart.RedirectStandardError=$true
  $taskChild=[Diagnostics.Process]::Start($taskStart)
  try {
    $taskOutput=$taskChild.StandardOutput.ReadToEndAsync();$taskError=$taskChild.StandardError.ReadToEndAsync()
    if(-not $taskChild.WaitForExit(40000)){ $taskChild.Kill(); throw 'Fixture child timed out' }
    Write-Output $taskOutput.Result
    if($taskChild.ExitCode -ne 0){throw $taskError.Result}
  } finally {$taskChild.Dispose()}
} finally {
  $taskResolved=(Resolve-Path -LiteralPath $taskScratch).Path
  if([IO.Path]::GetDirectoryName($taskResolved) -ne [IO.Path]::GetTempPath().TrimEnd('\') -or
      ((Get-Item -LiteralPath $taskResolved).Attributes -band [IO.FileAttributes]::ReparsePoint)) {throw 'Unsafe fixture cleanup'}
  Remove-Item -LiteralPath $taskResolved -Recurse -Force
}
