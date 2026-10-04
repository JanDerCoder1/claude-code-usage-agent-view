'use strict';
// Keeps the floating window in front of ITS VS Code window only (not in front of other programs) and gives it a small size.
// VS Code itself only knows "always on top of everything" (workbench.action.enableWindowAlwaysOnTop). Windows has a better tool:
// an OWNED window always stays above its owner. This module makes the new editor window an owned window of the VS Code window it
// was opened from, with two short PowerShell runs (Windows only; the P/Invoke calls are EnumWindows, GetWindowText,
// GetWindowThreadProcessId, GetForegroundWindow, GetWindow and SetWindowLongPtr with GWLP_HWNDPARENT; verified between two
// throwaway windows of different processes, not yet inside a real VS Code window):
//   snapshot(): the foreground window (the VS Code window the button was clicked in) and all visible top-level windows of VS Code
//   link():     the one window that appeared since the snapshot becomes owned by the foreground window (owner:true) and is
//               resized and placed at the top right of that window (width/height > 0; DPI aware via GetDpiForWindow)
// Fixed script, no shell, no input from files or the view; the only values handed over are numbers and the process name of the editor.
const { execFile } = require('child_process');

const TIMEOUT_MS = 15000;
const RETRIES = 6;
const RETRY_MS = 500;

// Closes the floating window when the VS Code window it belongs to is gone. Windows does not do that across processes
// (an owned window of another process outlives its owner), and VS Code's own handling is not something to rely on.
const PS_WATCH = `
$ErrorActionPreference = 'Stop'
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class AvX {
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
}
'@
$m = [long]$env:AV_MAIN
$a = [long]$env:AV_AUX
$until = [DateTime]::UtcNow.AddHours(12)
while ([DateTime]::UtcNow -lt $until) {
  if (-not [AvX]::IsWindow([IntPtr]$a)) { exit 0 }
  if (-not [AvX]::IsWindow([IntPtr]$m)) { [void][AvX]::PostMessage([IntPtr]$a, 0x0010, [IntPtr]0, [IntPtr]0); Start-Sleep -Milliseconds 1500; exit 0 }
  Start-Sleep -Milliseconds 1000
}
`;

const PS_HEAD = `
$ErrorActionPreference = 'Stop'
Add-Type @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class AvW {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW")] static extern IntPtr SetWindowLongPtr(IntPtr h, int i, IntPtr v);
  public static long Foreground() { return (long)GetForegroundWindow(); }
  public static long Owner(long h) { return (long)GetWindow((IntPtr)h, 4); }
  public static long SetOwner(long h, long owner) { return (long)SetWindowLongPtr((IntPtr)h, -8, (IntPtr)owner); }
  public static string Place(long h, long main, int w, int hgt) {
    SetProcessDPIAware();
    uint dpi = GetDpiForWindow((IntPtr)h); double sc = dpi > 0 ? dpi / 96.0 : 1.0;
    RECT m; if (!GetWindowRect((IntPtr)main, out m)) return "rect";
    int cw = (int)Math.Round(w * sc), ch = (int)Math.Round(hgt * sc);
    int x = Math.Max(m.Left, m.Right - cw - (int)Math.Round(24 * sc)); int y = m.Top + (int)Math.Round(90 * sc);
    return SetWindowPos((IntPtr)h, IntPtr.Zero, x, y, cw, ch, 0x0014) ? "" : "pos";
  }
  public static uint Pid(long h) { uint p; GetWindowThreadProcessId((IntPtr)h, out p); return p; }
  public static string Title(long h) { var sb = new StringBuilder(512); GetWindowText((IntPtr)h, sb, 512); return sb.ToString(); }
  public static List<long> All(int[] pids) {
    var set = new HashSet<int>(pids); var res = new List<long>();
    EnumWindows((h, l) => { if (!IsWindowVisible(h)) return true; uint p; GetWindowThreadProcessId(h, out p); if (!set.Contains((int)p)) return true; if (GetWindow(h, 4) != IntPtr.Zero) return true; var sb = new StringBuilder(8); if (GetWindowText(h, sb, 8) == 0) return true; res.Add((long)h); return true; }, IntPtr.Zero);
    return res;
  }
}
'@
$pids = @(Get-Process -Name $env:AV_PROC -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$apids = $pids
if ($env:AV_AUXPROC) { $apids = @(Get-Process -Name $env:AV_AUXPROC -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) }
`;

const PS_SNAPSHOT = PS_HEAD + `
$fg = [AvW]::Foreground()
$all = [AvW]::All([int[]]$pids)
$isCode = $all -contains $fg
@{ ok = $isCode; main = $(if ($isCode) { $fg } else { 0 }); before = @([AvW]::All([int[]]$apids)) } | ConvertTo-Json -Compress
`;

const PS_LINK = PS_HEAD + `
$main = [long]$env:AV_MAIN
$owner = ($env:AV_OWNER -eq '1')
$w = [int]$env:AV_W
$h = [int]$env:AV_H
$before = @($env:AV_BEFORE -split ',' | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [long]$_ })
$now = [AvW]::All([int[]]$apids)
$new = @($now | Where-Object { $before -notcontains $_ -and $_ -ne $main })
if ($new.Count -gt 1) { $new = @($new | Where-Object { [AvW]::Title($_) -like 'Claude Code Utilities*' }) }
if ($new.Count -ne 1) { @{ ok = $false; why = $(if ($new.Count -eq 0) { 'none' } else { 'ambiguous' }) } | ConvertTo-Json -Compress; exit 0 }
$why = ''
if ($owner) {
  [void][AvW]::SetOwner($new[0], $main)
  if ([AvW]::Owner($new[0]) -ne $main) { $why = 'refused' }
}
$placed = ''
if ($w -gt 0 -and $h -gt 0) { $placed = [AvW]::Place($new[0], $main, $w, $h) }
@{ ok = ($why -eq ''); aux = $new[0]; why = $why; place = $placed } | ConvertTo-Json -Compress
`;

// Brings the floating window forward again (restore if minimised) when the button is pressed while it is open.
const PS_ACTIVATE = `
$ErrorActionPreference = 'Stop'
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class AvA {
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
'@
$a = [long]$env:AV_AUX
if ([AvA]::IsWindow([IntPtr]$a)) { [void][AvA]::ShowWindow([IntPtr]$a, 9); [void][AvA]::SetForegroundWindow([IntPtr]$a); @{ ok = $true } | ConvertTo-Json -Compress } else { @{ ok = $false; why = 'gone' } | ConvertTo-Json -Compress }
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (e) => String((e && (e.code || e.signal || e.message)) || 'error').slice(0, 60);

class WindowLinker {
  /** @param {{ procName: string, platform?: string, execFile?: Function, log?: (m:string)=>void, retryMs?: number }} opts procName: process name of the editor (Code) */
  constructor(opts) {
    const o = opts || {};
    this.procName = /^[\w .-]{1,40}$/.test(String(o.procName || '')) ? String(o.procName) : '';
    this.auxProc = /^[\w .-]{1,40}$/.test(String(o.auxProc || '')) ? String(o.auxProc) : '';   // process of the NEW window when it is not an editor window (a browser)
    this.retries = Number.isSafeInteger(o.retries) && o.retries > 0 && o.retries <= 40 ? o.retries : RETRIES;
    this.platform = o.platform || process.platform;
    this._exec = o.execFile || execFile;
    this.log = typeof o.log === 'function' ? o.log : () => {};
    this.retryMs = typeof o.retryMs === 'number' ? o.retryMs : RETRY_MS;
  }

  _procEnv() { return { AV_PROC: this.procName, AV_AUXPROC: this.auxProc }; }

  _ps(script, env) {
    return new Promise((resolve) => {
      let child;
      try {
        child = this._exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
          { env: Object.assign({}, process.env, env), windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024, encoding: 'utf8' },
          (err, stdout) => {
            if (err) return resolve({ ok: false, why: short(err) });
            const line = String(stdout || '').trim().split(/\r?\n/).pop() || '';
            try { const j = JSON.parse(line); resolve(j && typeof j === 'object' ? j : { ok: false, why: 'output' }); } catch (_) { resolve({ ok: false, why: 'output' }); }
          });
        if (child && child.stdin && typeof child.stdin.end === 'function') child.stdin.end();
      } catch (e) { resolve({ ok: false, why: short(e) }); }
    });
  }

  /** Call while the VS Code window the button was pressed in is still the foreground window, before the new window exists. */
  async snapshot() {
    if (this.platform !== 'win32') return { ok: false, why: 'platform' };
    if (!this.procName) return { ok: false, why: 'process' };
    const r = await this._ps(PS_SNAPSHOT, this._procEnv());
    if (!r.ok) return { ok: false, why: r.why || 'no-main' };
    const nums = (a) => (Array.isArray(a) ? a : [a]).filter((n) => Number.isSafeInteger(n) && n > 0);
    const main = Number.isSafeInteger(r.main) && r.main > 0 ? r.main : 0;
    if (!main) return { ok: false, why: 'no-main' };
    return { ok: true, main, before: nums(r.before) };
  }

  /**
   * After the move command: waits (briefly) for the new window, then (opts.owner) makes it owned by the main window and (opts.width/height > 0,
   * in device-independent pixels) resizes it and puts it at the top right of the main window. Resolves { ok, place } | { ok:false, why }.
   */
  async link(snap, opts) {
    const o = opts || {};
    const dim = (n) => (Number.isSafeInteger(n) && n >= 200 && n <= 4000 ? n : 0);
    if (!snap || !snap.ok) return { ok: false, why: (snap && snap.why) || 'no-snapshot' };
    let last = { ok: false, why: 'none' };
    for (let i = 0; i < this.retries; i++) {
      if (i) await sleep(this.retryMs);
      last = await this._ps(PS_LINK, { AV_PROC: this.procName, AV_AUXPROC: this.auxProc, AV_MAIN: String(snap.main), AV_BEFORE: snap.before.join(','), AV_OWNER: o.owner === true ? '1' : '0', AV_W: String(dim(o.width)), AV_H: String(dim(o.height)) });
      if (last.ok || (last.why !== 'none')) break;      // 'none' = the window is not there yet
    }
    if (!last.ok) return { ok: false, why: last.why || 'error' };
    const res = { ok: true, place: last.place || '' };
    if (Number.isSafeInteger(last.aux) && last.aux > 0) res.aux = last.aux;
    return res;
  }

  /** Starts the watcher: closes the window `aux` as soon as the window `main` no longer exists. Returns { stop() }; never throws. */
  watch(main, aux, onGone) {
    const ok = (n) => Number.isSafeInteger(n) && n > 0;
    if (this.platform !== 'win32' || !ok(main) || !ok(aux)) return { stop() {} };
    let child = null, stopped = false;
    try {
      child = this._exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_WATCH],
        { env: Object.assign({}, process.env, { AV_MAIN: String(main), AV_AUX: String(aux) }), windowsHide: true, timeout: 12 * 3600e3 + 60e3, maxBuffer: 1024 * 1024 },
        () => { if (!stopped && typeof onGone === 'function') { try { onGone(); } catch (e) { /* the caller's problem */ } } });
      if (child && child.stdin && typeof child.stdin.end === 'function') child.stdin.end();
    } catch (e) { return { stop() {} }; }
    return { stop() { stopped = true; try { if (child && typeof child.kill === 'function') child.kill(); } catch (e) { /* gone */ } } };
  }

  /** Brings the window `aux` forward (restores it when minimised). Resolves { ok } | { ok:false, why }. */
  async activate(aux) {
    if (this.platform !== 'win32' || !Number.isSafeInteger(aux) || aux <= 0) return { ok: false, why: 'platform' };
    const r = await this._ps(PS_ACTIVATE, { AV_AUX: String(aux) });
    return r.ok ? { ok: true } : { ok: false, why: r.why || 'error' };
  }
}

module.exports = { WindowLinker, PS_SNAPSHOT, PS_LINK, PS_WATCH, PS_ACTIVATE, RETRIES };
