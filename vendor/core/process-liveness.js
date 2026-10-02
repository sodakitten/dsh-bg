import { execFile } from "node:child_process";
/**
 * How close a process's actual start time must be to the recorded start time
 * before we treat them as the same process. PID reuse yields a completely
 * different start time, so a generous window is safe while still rejecting
 * recycled PIDs.
 */
const START_TIME_TOLERANCE_MS = 30_000;
/**
 * True when `pid` refers to a process that still exists. Mirrors the PID check
 * callers perform before consulting a recorded process identity.
 */
function isPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return (Boolean(error) &&
            typeof error === "object" &&
            error.code === "EPERM");
    }
}
/**
 * Resolve the actual process start time as an epoch millisecond value.
 * Returns null when the process does not exist or the platform helper fails.
 */
function processStartTimeMs(pid) {
    return new Promise((resolve) => {
        if (process.platform === "win32") {
            const script = `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`;
            execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 3_000, windowsHide: true }, (error, stdout) => {
                if (error)
                    return resolve(null);
                const value = Date.parse(String(stdout).trim());
                resolve(Number.isFinite(value) ? value : null);
            });
            return;
        }
        // Linux / macOS: ps -o lstart= prints the start time in local time with no
        // timezone suffix, which Date.parse interprets as the host's local time.
        execFile("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 3_000 }, (error, stdout) => {
            if (error)
                return resolve(null);
            const value = Date.parse(String(stdout).trim());
            resolve(Number.isFinite(value) ? value : null);
        });
    });
}
/**
 * True when `pid` is alive AND its real start time matches `recordedIso` (the
 * startedAt value a control/claim file captured when the process launched).
 *
 * Falls back to optimistic `true` when there is no recorded timestamp or the
 * platform helper is unavailable, so an unverifiable check never marks a live
 * tray/session as dead. Returns `false` when the PID no longer exists or its
 * start time clearly differs (PID reuse).
 */
export async function isRecordedPidLive(pid, recordedIso) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    if (!isPidAlive(pid))
        return false;
    if (typeof recordedIso !== "string" || !recordedIso)
        return true;
    const recordedMs = Date.parse(recordedIso);
    if (!Number.isFinite(recordedMs))
        return true;
    let actualMs;
    try {
        actualMs = await processStartTimeMs(pid);
    }
    catch {
        actualMs = null;
    }
    // No helper result means "cannot verify" — keep the optimistic PID check.
    if (actualMs == null)
        return true;
    return Math.abs(actualMs - recordedMs) <= START_TIME_TOLERANCE_MS;
}
//# sourceMappingURL=process-liveness.js.map