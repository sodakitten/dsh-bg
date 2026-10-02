import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { DEFAULT_TRUSTED_ORIGINS, IMAGE_EXTENSIONS, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, MEDIA_TOKEN_HEADER, MEDIA_TOKEN_HEADER_CANON, TRUSTED_ORIGIN_PREFIXES, isVideoExtension, VIDEO_MIME, } from "./constants.js";
import { validateImageFile, validateVideoFile, } from "./media-validation.js";
function parseRange(value, size) {
    if (typeof value !== "string" || !value.startsWith("bytes="))
        return null;
    const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
    if (!match || (!match[1] && !match[2]))
        return null;
    let start;
    let end;
    if (match[1]) {
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : size - 1;
    }
    else {
        const suffix = Number(match[2]);
        if (!Number.isSafeInteger(suffix) || suffix < 1)
            return null;
        start = Math.max(0, size - suffix);
        end = size - 1;
    }
    if (!Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end < start) {
        return null;
    }
    if (start >= size)
        return { unsatisfiable: true };
    return { start, end: Math.min(end, size - 1) };
}
function makeToken() {
    return randomUUID().replaceAll("-", "");
}
async function hashOpenedFile(handle, size) {
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < size) {
        const length = Math.min(chunk.byteLength, size - position);
        const { bytesRead } = await handle.read(chunk, 0, length, position);
        if (bytesRead <= 0)
            throw new Error("Media file ended while revalidating");
        hash.update(chunk.subarray(0, bytesRead));
        position += bytesRead;
    }
    return hash.digest("hex");
}
/** Exact match or app://* prefix (hub is loopback-only). */
function matchTrustedOrigin(origin, trusted) {
    if (!origin)
        return null;
    if (trusted.has(origin))
        return origin;
    for (const prefix of TRUSTED_ORIGIN_PREFIXES) {
        if (origin.startsWith(prefix))
            return origin;
    }
    return null;
}
/**
 * Multi-route loopback hub. One TCP port, many /media/<token> assets.
 */
export class LoopbackMediaHub {
    trustedOrigins;
    maxImageBytes;
    maxVideoBytes;
    server = null;
    sockets = new Set();
    transferControllers = new Set();
    transfers = new Set();
    assets = new Map();
    closed = false;
    port = 0;
    listenPromise = null;
    constructor(opts = {}) {
        this.trustedOrigins = new Set(opts.trustedOrigins ?? DEFAULT_TRUSTED_ORIGINS);
        this.maxImageBytes = opts.maxImageBytes ?? MAX_IMAGE_BYTES;
        this.maxVideoBytes = opts.maxVideoBytes ?? MAX_VIDEO_BYTES;
    }
    get listeningPort() {
        return this.port;
    }
    get assetCount() {
        return this.assets.size;
    }
    async ensureListening() {
        if (this.server)
            return;
        if (this.closed)
            throw new Error("Media hub is closed");
        if (this.listenPromise)
            return this.listenPromise;
        this.listenPromise = (async () => {
            const server = http.createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 30_000 }, (req, res) => {
                void this.handle(req, res);
            });
            server.headersTimeout = 10_000;
            server.keepAliveTimeout = 5_000;
            server.maxRequestsPerSocket = 100;
            server.on("connection", (socket) => {
                this.sockets.add(socket);
                socket.once("close", () => this.sockets.delete(socket));
            });
            await new Promise((resolve, reject) => {
                server.once("error", reject);
                server.listen(0, "127.0.0.1", () => resolve());
            });
            const address = server.address();
            if (!address || typeof address === "string") {
                await new Promise((resolve) => server.close(() => resolve()));
                throw new Error("Local media server did not expose a TCP port.");
            }
            if (this.closed) {
                await new Promise((resolve) => server.close(() => resolve()));
                throw new Error("Media hub closed while listener was starting.");
            }
            this.server = server;
            this.port = address.port;
        })();
        try {
            await this.listenPromise;
        }
        finally {
            this.listenPromise = null;
        }
    }
    async addFile(filePath, opts = {}) {
        const validation = opts.validation ?? "full";
        const ext = path.extname(filePath).toLowerCase();
        let kind;
        let mime;
        let size;
        let identity;
        let device;
        let inode;
        let mtimeMs;
        let ctimeMs;
        let resolved;
        if (IMAGE_EXTENSIONS.includes(ext)) {
            const v = await validateImageFile(filePath, {
                maxBytes: this.maxImageBytes,
                mode: validation,
            });
            kind = "image";
            mime = v.mime;
            size = v.size;
            identity = v.identity;
            device = v.device;
            inode = v.inode;
            mtimeMs = v.mtimeMs;
            ctimeMs = v.ctimeMs;
            resolved = v.filePath;
        }
        else if (isVideoExtension(ext)) {
            const v = await validateVideoFile(filePath, {
                maxBytes: this.maxVideoBytes,
                mode: validation,
            });
            kind = "video";
            mime = VIDEO_MIME;
            size = v.size;
            identity = v.identity;
            device = v.device;
            inode = v.inode;
            mtimeMs = v.mtimeMs;
            ctimeMs = v.ctimeMs;
            resolved = v.filePath;
        }
        else {
            throw new Error(`Unsupported media extension: ${ext || "(none)"}`);
        }
        // Validate first. Invalid input must not leave an unreachable listener.
        await this.ensureListening();
        // Reuse identical asset.
        for (const existing of this.assets.values()) {
            if (existing.filePath === resolved &&
                existing.size === size &&
                existing.identity === identity &&
                existing.kind === kind) {
                return this.toHandle(existing);
            }
        }
        const token = makeToken();
        const route = `/media/${token}`;
        const rec = {
            kind,
            filePath: resolved,
            size,
            identity,
            device,
            inode,
            mtimeMs,
            ctimeMs,
            mime,
            validation,
            token,
            route,
        };
        this.assets.set(token, rec);
        return this.toHandle(rec);
    }
    async remove(token) {
        if (!token)
            return;
        this.assets.delete(token);
    }
    async close() {
        this.closed = true;
        this.assets.clear();
        await this.listenPromise?.catch(() => { });
        for (const controller of this.transferControllers)
            controller.abort();
        await Promise.allSettled([...this.transfers]);
        await this.closeServerOnly();
    }
    toHandle(rec) {
        const url = `http://127.0.0.1:${this.port}${rec.route}`;
        return {
            kind: rec.kind,
            filePath: rec.filePath,
            size: rec.size,
            identity: rec.identity,
            device: rec.device,
            inode: rec.inode,
            mtimeMs: rec.mtimeMs,
            ctimeMs: rec.ctimeMs,
            mime: rec.mime,
            validation: rec.validation,
            token: rec.token,
            route: rec.route,
            url,
            srcUrl: `${url}?t=${encodeURIComponent(rec.token)}`,
        };
    }
    async closeServerOnly() {
        const server = this.server;
        this.server = null;
        this.port = 0;
        if (!server)
            return;
        for (const socket of this.sockets) {
            try {
                socket.destroy();
            }
            catch {
                /* ignore */
            }
        }
        this.sockets.clear();
        // Node 18.2+: drop keep-alive / half-open clients so close() settles on Windows.
        if (typeof server.closeAllConnections === "function") {
            try {
                server.closeAllConnections();
            }
            catch {
                /* ignore */
            }
        }
        await new Promise((resolve) => {
            server.close(() => resolve());
            // Failsafe: never hang process exit on a stuck listener.
            setTimeout(resolve, 500).unref?.();
        });
    }
    async pipeOpenedFile(opened, request, response, range) {
        const controller = new AbortController();
        const abort = () => controller.abort();
        const abortIfIncomplete = () => {
            if (!response.writableFinished)
                controller.abort();
        };
        request.once("aborted", abort);
        response.once("close", abortIfIncomplete);
        this.transferControllers.add(controller);
        const transfer = (async () => {
            try {
                const stream = opened.createReadStream({
                    start: range.start,
                    ...(range.end == null ? {} : { end: range.end }),
                    // The hub owns the FileHandle lifecycle. This guarantees a close on
                    // normal completion, browser Range cancellation, and hub shutdown.
                    autoClose: false,
                });
                if (request.aborted || response.destroyed || this.closed)
                    controller.abort();
                await pipeline(stream, response, { signal: controller.signal });
            }
            finally {
                request.removeListener("aborted", abort);
                response.removeListener("close", abortIfIncomplete);
                this.transferControllers.delete(controller);
                await opened.close().catch(() => { });
            }
        })();
        this.transfers.add(transfer);
        try {
            await transfer;
        }
        finally {
            this.transfers.delete(transfer);
        }
    }
    async handle(request, response) {
        const originHeader = request.headers.origin;
        const origin = typeof originHeader === "string" ? originHeader : undefined;
        const trustedOrigin = matchTrustedOrigin(origin, this.trustedOrigins);
        const corsHeaders = {
            "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
            "Access-Control-Allow-Headers": [
                "Range",
                MEDIA_TOKEN_HEADER_CANON,
                "Content-Type",
                "Accept",
            ].join(", "),
            // Required for Chromium Private Network Access (app:// → 127.0.0.1).
            "Access-Control-Allow-Private-Network": "true",
            "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range, Content-Type",
            Vary: "Origin",
        };
        if (trustedOrigin) {
            corsHeaders["Access-Control-Allow-Origin"] = trustedOrigin;
        }
        const rawUrl = request.url ?? "";
        const urlPath = rawUrl.split("?", 1)[0] ?? "";
        const pathMatch = /^\/media\/([A-Za-z0-9]{16,64})$/.exec(urlPath);
        const pathToken = pathMatch?.[1] ?? null;
        if (pathToken && request.method === "OPTIONS") {
            if (origin && !trustedOrigin) {
                response.writeHead(403, { "Cache-Control": "no-store" });
                response.end();
                return;
            }
            response.writeHead(204, corsHeaders);
            response.end();
            return;
        }
        if (this.closed ||
            !request.method ||
            !["GET", "HEAD"].includes(request.method) ||
            !pathToken) {
            response.writeHead(this.closed ? 503 : 404, {
                "Cache-Control": "no-store",
            });
            response.end();
            return;
        }
        // Auth: path token identifies asset; require matching header OR ?t=
        const headerRaw = request.headers[MEDIA_TOKEN_HEADER];
        const headerToken = typeof headerRaw === "string"
            ? headerRaw
            : Array.isArray(headerRaw)
                ? headerRaw[0]
                : "";
        let queryToken = "";
        try {
            queryToken = new URL(rawUrl, "http://127.0.0.1").searchParams.get("t") ?? "";
        }
        catch {
            queryToken = "";
        }
        const tokenOk = headerToken === pathToken || queryToken === pathToken;
        if ((origin && !trustedOrigin) || !tokenOk) {
            response.writeHead(403, { "Cache-Control": "no-store" });
            response.end();
            return;
        }
        const asset = this.assets.get(pathToken);
        if (!asset) {
            response.writeHead(404, { "Cache-Control": "no-store" });
            response.end();
            return;
        }
        let opened = null;
        try {
            const lstat = await fs.lstat(asset.filePath);
            if (lstat.isSymbolicLink()) {
                throw new Error("Media path became a symbolic link");
            }
            opened = await fs.open(asset.filePath, "r");
            const stat = await opened.stat();
            const maxBytes = asset.kind === "image" ? this.maxImageBytes : this.maxVideoBytes;
            const fingerprintChanged = stat.dev !== asset.device ||
                stat.ino !== asset.inode ||
                stat.mtimeMs !== asset.mtimeMs ||
                stat.ctimeMs !== asset.ctimeMs;
            if (!stat.isFile() ||
                stat.size !== asset.size ||
                stat.size > maxBytes) {
                throw new Error("Media file changed or exceeded the safety limit");
            }
            if (fingerprintChanged) {
                if (asset.validation === "fast") {
                    throw new Error("Media file changed after staging");
                }
                const currentHash = await hashOpenedFile(opened, stat.size);
                if (currentHash !== asset.identity) {
                    throw new Error("Media file content changed after staging");
                }
                asset.device = stat.dev;
                asset.inode = stat.ino;
                asset.mtimeMs = stat.mtimeMs;
                asset.ctimeMs = stat.ctimeMs;
            }
            const rangeHeader = request.headers.range;
            const range = parseRange(rangeHeader, stat.size);
            const headers = {
                ...corsHeaders,
                "Content-Type": asset.mime,
                "Accept-Ranges": "bytes",
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
            };
            if (rangeHeader !== undefined && !range) {
                headers["Content-Range"] = `bytes */${stat.size}`;
                response.writeHead(416, headers);
                response.end();
                await opened.close();
                opened = null;
                return;
            }
            if (range && "unsatisfiable" in range) {
                headers["Content-Range"] = `bytes */${stat.size}`;
                response.writeHead(416, headers);
                response.end();
                await opened.close();
                opened = null;
                return;
            }
            if (!range) {
                headers["Content-Length"] = stat.size;
                response.writeHead(200, headers);
                if (request.method === "HEAD") {
                    response.end();
                    await opened.close();
                    opened = null;
                    return;
                }
                const streamingHandle = opened;
                opened = null;
                await this.pipeOpenedFile(streamingHandle, request, response, { start: 0 });
                return;
            }
            headers["Content-Range"] =
                `bytes ${range.start}-${range.end}/${stat.size}`;
            headers["Content-Length"] = range.end - range.start + 1;
            response.writeHead(206, headers);
            if (request.method === "HEAD") {
                response.end();
                await opened.close();
                opened = null;
                return;
            }
            const streamingHandle = opened;
            opened = null;
            await this.pipeOpenedFile(streamingHandle, request, response, {
                start: range.start,
                end: range.end,
            });
        }
        catch {
            await opened?.close().catch(() => { });
            if (response.headersSent) {
                response.destroy();
            }
            else {
                response.writeHead(404, { "Cache-Control": "no-store" });
                response.end();
            }
        }
    }
}
/**
 * Back-compat single-asset helper used by older call sites/tests.
 */
export async function createMediaServer(filePath, opts = {}) {
    const hub = new LoopbackMediaHub(opts);
    const asset = await hub.addFile(filePath);
    return {
        ...asset,
        async close() {
            await hub.close();
        },
    };
}
function isAssetHandle(value) {
    if (!value || typeof value !== "object")
        return false;
    const v = value;
    return ((v.kind === "image" || v.kind === "video") &&
        typeof v.token === "string" &&
        typeof v.srcUrl === "string" &&
        !("image" in v && typeof v.image === "object") &&
        !("video" in v && typeof v.video === "object"));
}
function isPairCommit(value) {
    if (!value || typeof value !== "object")
        return false;
    // Pair shape is chosen when image/video keys are present (even if null).
    return "image" in value || "video" in value;
}
/**
 * Controller that can hold poster image + video assets on one hub.
 */
export class MediaServerController {
    #hub;
    #enabled;
    #image = null;
    #video = null;
    constructor(opts = {}) {
        this.#enabled = opts.enabled ?? true;
        this.#hub = new LoopbackMediaHub(opts);
    }
    /** @deprecated use activeVideo; kept for callers expecting a single active */
    get active() {
        return this.#video ?? this.#image;
    }
    get activeImage() {
        return this.#image;
    }
    get activeVideo() {
        return this.#video;
    }
    async stage(filePath, opts = {}) {
        if (!filePath || !this.#enabled)
            return null;
        return this.#hub.addFile(filePath, opts);
    }
    /**
     * Promote staged image/video handles; close assets that are no longer needed.
     */
    async commit(next) {
        let nextImage = null;
        let nextVideo = null;
        if (next == null) {
            nextImage = null;
            nextVideo = null;
        }
        else if (isPairCommit(next)) {
            nextImage = next.image ?? null;
            nextVideo = next.video ?? null;
        }
        else if (isAssetHandle(next)) {
            // Legacy single-handle commit.
            if (next.kind === "image")
                nextImage = next;
            else
                nextVideo = next;
        }
        else {
            throw new Error("Invalid media commit payload.");
        }
        const prevImage = this.#image;
        const prevVideo = this.#video;
        this.#image = nextImage;
        this.#video = nextVideo;
        // Drop unreferenced assets. Keep tokens that are still active (including
        // the case where image+video swap roles is impossible — kinds differ).
        const keep = new Set();
        if (nextImage)
            keep.add(nextImage.token);
        if (nextVideo)
            keep.add(nextVideo.token);
        if (prevImage && !keep.has(prevImage.token)) {
            await this.#hub.remove(prevImage.token);
        }
        if (prevVideo && !keep.has(prevVideo.token)) {
            await this.#hub.remove(prevVideo.token);
        }
    }
    async abort(staged) {
        if (!staged)
            return;
        if (staged.token === this.#image?.token ||
            staged.token === this.#video?.token) {
            return;
        }
        await this.#hub.remove(staged.token);
    }
    async close() {
        this.#image = null;
        this.#video = null;
        await this.#hub.close();
    }
}
//# sourceMappingURL=media-server.js.map