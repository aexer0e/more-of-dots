[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$targetRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'src-tauri/target')) + [IO.Path]::DirectorySeparatorChar
$output = & cargo test --manifest-path (Join-Path $projectRoot 'src-tauri/Cargo.toml') --lib --no-run --message-format=json
if ($LASTEXITCODE -ne 0) { throw 'Native tests did not compile.' }
$executables = @($output | ForEach-Object {
  try { $message = $_ | ConvertFrom-Json } catch { return }
  if ($message.reason -eq 'compiler-artifact' -and $message.profile.test -and $message.executable) { $message.executable }
})
if ($executables.Count -ne 1) { throw 'Could not identify the library test executable.' }
$executable = [IO.Path]::GetFullPath($executables[0])
if (-not $executable.StartsWith($targetRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Test executable is outside this project target directory.' }
# tauri-build links the Windows manifest to app binaries. Library test binaries
# also need Common Controls v6 for the native dialog imports.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class MoreOfDotsTestManifest {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr BeginUpdateResourceW(string file, bool delete);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool UpdateResourceW(IntPtr handle, IntPtr type, IntPtr name, ushort language, byte[] data, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool EndUpdateResourceW(IntPtr handle, bool discard);
  public static void Write(string file, byte[] manifest) {
    var handle=BeginUpdateResourceW(file,false);
    if(handle==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    if(!UpdateResourceW(handle,(IntPtr)24,(IntPtr)1,0,manifest,(uint)manifest.Length)) {
      var error=new Win32Exception(Marshal.GetLastWin32Error());EndUpdateResourceW(handle,true);throw error;
    }
    if(!EndUpdateResourceW(handle,false)) throw new Win32Exception(Marshal.GetLastWin32Error());
  }
}
'@
$manifest = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0"><assemblyIdentity version="1.0.0.0" processorArchitecture="*" name="MoreOfDots.BackendTests" type="win32"/><dependency><dependentAssembly><assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/></dependentAssembly></dependency></assembly>'
[MoreOfDotsTestManifest]::Write($executable, [Text.Encoding]::UTF8.GetBytes($manifest))
$cargoRoot = if ($env:CARGO_HOME) { $env:CARGO_HOME } else { Join-Path $env:USERPROFILE '.cargo' }
$webviewVersion = [regex]::Match((Get-Content -LiteralPath (Join-Path $projectRoot 'src-tauri/Cargo.lock') -Raw), '(?m)^name = "webview2-com-sys"\r?\nversion = "([^"]+)"').Groups[1].Value
foreach ($registry in Get-ChildItem -LiteralPath (Join-Path $cargoRoot 'registry/src') -Directory) {
  $loader = Join-Path $registry.FullName "webview2-com-sys-$webviewVersion/x64/WebView2Loader.dll"
  if (Test-Path -LiteralPath $loader) { Copy-Item -LiteralPath $loader -Destination ([IO.Path]::GetDirectoryName($executable)) -Force; break }
}
& $executable
if ($LASTEXITCODE -ne 0) { throw 'Native tests failed.' }
