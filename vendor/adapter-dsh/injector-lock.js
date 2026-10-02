import fs from "node:fs/promises";
import path from "node:path";
import { acquireFileLock } from "../core/index.js";
/** Shares injector.lock with the Codex adapter to prevent cross-host writes. */
export async function acquireDshInjectorLock(dataRoot) {
    await fs.mkdir(dataRoot, { recursive: true });
    const file = path.join(dataRoot, "injector.lock");
    const lease = await acquireFileLock(file, { purpose: "beautiCode injector" });
    const lock = {
        pid: lease.owner.pid,
        port: 0,
        host: "dsh",
        startedAt: lease.owner.startedAt,
        nonce: lease.owner.nonce,
    };
    const handle = await fs.open(file, "r+");
    try {
        await handle.truncate(0);
        await handle.writeFile(`${JSON.stringify(lock, null, 2)}\n`, "utf8");
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    return () => lease.release();
}
//# sourceMappingURL=injector-lock.js.map