import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Window-scoped Win11 DWM border policy; the helper verifies Host ancestry. */
export function createWindowBorder({ platform = process.platform, spawnProcess = spawn } = {}) {
  let worker = null, attempted = false, disposed = false, desired = false;
  let status = { supported: null, hidden: false, windows: 0 };
  const send = (line) => {
    if (worker?.stdin?.writable) worker.stdin.write(line + '\n');
  };
  return {
    get status() { return { ...status, requested: desired }; },
    setHidden(hidden) {
      if (disposed || platform !== 'win32') return;
      const changed = desired !== (hidden === true);
      desired = hidden === true;
      if (worker) { if (changed) send(desired ? 'hide' : 'show'); return; }
      if (!desired || attempted) return;
      attempted = true;
      try {
        worker = spawnProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
          '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./scripts/window-border.ps1', import.meta.url)),
          '-HostPid', String(process.pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        const child = worker;
        let pending = '', error = '';
        child.stdin.on('error', () => {});
        child.stdout.on('data', chunk => {
          pending += String(chunk);
          if (pending.length > 8192) { pending = ''; return; }
          let end;
          while ((end = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, end); pending = pending.slice(end + 1);
            try {
              const report = JSON.parse(line);
              if (typeof report.supported === 'boolean' && typeof report.hidden === 'boolean')
                status = { supported: report.supported, hidden: report.hidden, windows: Number(report.windows) || 0,
                  ...(typeof report.reason === 'string' ? { reason: report.reason.slice(0, 100) } : {}) };
            } catch {}
          }
        });
        child.stderr.on('data', chunk => { error = (error + String(chunk)).slice(0, 500); });
        child.on('error', () => { status = { supported: false, hidden: false, windows: 0, reason: 'helper-start-failed' }; });
        child.on('exit', code => {
          if (worker === child) worker = null;
          status = { ...status, hidden: false, windows: 0,
            ...(code ? { reason: error ? 'helper-failed' : 'helper-exited' } : {}) };
        });
        send('hide');
      } catch { worker = null; status = { supported: false, hidden: false, windows: 0, reason: 'helper-start-failed' }; }
    },
    dispose() {
      if (disposed) return;
      disposed = true; desired = false;
      // EOF restores the DWM system default in the helper's finally block.
      // Never kill it before restoration, or touch another app's window.
      worker?.stdin?.end();
    },
  };
}
