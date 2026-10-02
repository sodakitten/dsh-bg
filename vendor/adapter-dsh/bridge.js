export function normalizeDshBaseUrl(value) {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== "http:" ||
        !["127.0.0.1", "localhost", "[::1]"].includes(hostname) ||
        url.username ||
        url.password ||
        (url.pathname !== "" && url.pathname !== "/") ||
        url.search ||
        url.hash) {
        throw new Error("DeepSeek Harness URL must be loopback HTTP.");
    }
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url;
}
export function dshTrustedOrigins(value) {
    const baseUrl = normalizeDshBaseUrl(String(value));
    const port = baseUrl.port ? `:${baseUrl.port}` : "";
    return [
        ...new Set([
            baseUrl.origin,
            new URL(`http://127.0.0.1${port}`).origin,
            new URL(`http://localhost${port}`).origin,
            new URL(`http://[::1]${port}`).origin,
            "dsh-app://app",
        ]),
    ];
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
export class DshHostApplier {
    baseUrl;
    requestTimeoutMs;
    pollMs;
    token;
    lastStatus = null;
    constructor(opts) {
        this.baseUrl = normalizeDshBaseUrl(opts.baseUrl ?? "http://127.0.0.1:3080");
        this.token = opts.token;
        this.requestTimeoutMs = opts.requestTimeoutMs ?? 3_000;
        this.pollMs = opts.pollMs ?? 150;
    }
    get origin() {
        return this.baseUrl.origin;
    }
    get activeSessionCount() {
        return this.lastStatus?.connectedClients ?? 0;
    }
    async status() {
        try {
            const status = await this.#request("status", { method: "GET" });
            if (!status || status.ok !== true || !Number.isInteger(status.connectedClients)) {
                throw new Error("DeepSeek Harness bridge returned an invalid status.");
            }
            this.lastStatus = status;
            return status;
        }
        catch (error) {
            this.lastStatus = null;
            throw error;
        }
    }
    async apply(payload) {
        if (payload.media !== "clear" && !payload.imageUrl) {
            throw new Error("DeepSeek Harness background apply requires a loopback poster URL.");
        }
        if (payload.media === "video" && !payload.video?.srcUrl) {
            throw new Error("DeepSeek Harness video apply requires a loopback MP4 URL.");
        }
        const body = {
            generation: payload.generation,
            media: payload.media,
            imageUrl: payload.media === "clear" ? null : payload.imageUrl,
            videoUrl: payload.media === "video" ? payload.video?.srcUrl : null,
            startAt: payload.media === "video" && Number.isFinite(payload.video?.startAt)
                ? Math.max(0, Number(payload.video?.startAt))
                : null,
        };
        if (payload.atmosphere?.preset)
            body.atmosphere = payload.atmosphere;
        await this.#request("apply", {
            method: "POST",
            body: JSON.stringify(body),
        });
    }
    async setFishMode(enabled) {
        const result = await this.#setMode({ fish: Boolean(enabled) });
        return { ok: result.ok, fish: Boolean(enabled), sessions: result.sessions, ...(result.error ? { error: result.error } : {}) };
    }
    async setMuted(muted) {
        const result = await this.#setMode({ muted: Boolean(muted) });
        return {
            ok: result.ok,
            muted: Boolean(muted),
            blocked: result.blocked,
            sessions: result.sessions,
            ...(result.error ? { error: result.error } : {}),
        };
    }
    async setBackgroundTone(tone) {
        const normalized = tone === "light" || tone === "auto" ? tone : "dark";
        const result = await this.#setMode({ tone: normalized });
        return { ok: result.ok, tone: normalized, sessions: result.sessions, ...(result.error ? { error: result.error } : {}) };
    }
    async getPlaybackPosition() {
        const status = await this.status();
        const playback = status.playback;
        if (!playback?.hasVideo) {
            return { ok: false, currentTime: 0, duration: 0, hasVideo: false };
        }
        return {
            ok: true,
            currentTime: Number.isFinite(playback.currentTime) ? playback.currentTime : 0,
            duration: Number.isFinite(playback.duration) ? playback.duration : 0,
            hasVideo: true,
        };
    }
    async verify(expected, opts) {
        const deadline = Date.now() + Math.max(0, opts.deadlineMs);
        let last = null;
        let lastError = "DeepSeek Harness bridge is unavailable.";
        do {
            try {
                last = await this.status();
                const currentMatches = last.current?.generation === expected.generation &&
                    last.current.media === expected.media;
                if (currentMatches && last.readyClients > 0) {
                    return {
                        status: "pass",
                        reason: "DeepSeek Harness client acknowledged the background.",
                        details: { ...last },
                    };
                }
                if (currentMatches &&
                    last.connectedClients === 0) {
                    // Bridge already holds the payload; the next SSE client receives it
                    // on connect. Do not fail-closed as 422 just because the page is closed.
                    return {
                        status: "pass",
                        reason: "No DeepSeek Harness browser client is connected; background is queued for the next page.",
                        details: { ...last },
                    };
                }
                if (currentMatches &&
                    last.failedClients > 0 &&
                    last.readyClients === 0 &&
                    typeof last.lastRenderError === "string" &&
                    last.lastRenderError) {
                    return {
                        status: "fail",
                        reason: last.lastRenderError,
                        details: { ...last },
                    };
                }
                lastError = "DeepSeek Harness client has not acknowledged this generation.";
            }
            catch (error) {
                lastError = error instanceof Error ? error.message : String(error);
            }
            if (Date.now() >= deadline)
                break;
            await delay(Math.min(this.pollMs, Math.max(0, deadline - Date.now())));
        } while (true);
        return {
            status: "inconclusive",
            reason: lastError,
            ...(last ? { details: { ...last } } : {}),
        };
    }
    async #request(route, init) {
        const endpoint = new URL(`__beauticode/${route}`, this.baseUrl);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
        try {
            const response = await fetch(endpoint, {
                ...init,
                signal: controller.signal,
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    "Content-Type": "application/json",
                    ...(init.headers ?? {}),
                },
            });
            const body = (await response.json().catch(() => null));
            if (!response.ok) {
                const detail = typeof body?.error === "string" ? body.error : `HTTP ${response.status}`;
                throw new Error(`DeepSeek Harness bridge request failed: ${detail}`);
            }
            return body;
        }
        catch (error) {
            if (error?.name === "AbortError") {
                throw new Error("DeepSeek Harness bridge request timed out.");
            }
            throw error;
        }
        finally {
            clearTimeout(timer);
        }
    }
    async #setMode(change) {
        await this.#request("mode", { method: "POST", body: JSON.stringify(change) });
        const deadline = Date.now() + this.requestTimeoutMs;
        let last = null;
        do {
            try {
                last = await this.status();
                if (last.connectedClients === 0) {
                    return { ok: true, sessions: 0, blocked: false };
                }
                if (last.modeReadyClients > 0) {
                    return {
                        ok: true,
                        sessions: last.modeReadyClients,
                        blocked: last.blockedClients > 0,
                    };
                }
            }
            catch (error) {
                if (Date.now() >= deadline) {
                    return { ok: false, sessions: 0, blocked: false, error: error instanceof Error ? error.message : String(error) };
                }
            }
            if (Date.now() >= deadline)
                break;
            await delay(Math.min(this.pollMs, Math.max(0, deadline - Date.now())));
        } while (true);
        return {
            ok: false,
            sessions: 0,
            blocked: false,
            error: last?.connectedClients
                ? "DeepSeek Harness client did not acknowledge the mode change."
                : "No DeepSeek Harness browser client is connected.",
        };
    }
}
//# sourceMappingURL=bridge.js.map