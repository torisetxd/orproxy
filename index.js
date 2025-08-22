const http = require("http");
const https = require("https");

const MINUTE_MS = 60000;
const THIRTY_MIN_MS = 30 * 60000;

const RL_PER_MINUTE = Number.parseInt(process.env.RL_PER_MINUTE || "60", 10);
const RL_PER_30MIN = Number.parseInt(process.env.RL_PER_30MIN || "1000", 10);
const RL_MAX_KEYS = Number.parseInt(process.env.RL_MAX_KEYS || "10000", 10);
const RL_SWEEP_MS = Number.parseInt(process.env.RL_SWEEP_MS || "600000", 10);

const rlStore = new Map();

function getApiKey(req) {
    const h = req.headers || {};
    let key = null;

    const auth = typeof h.authorization === "string" ? h.authorization : null;
    if (auth) {
        if (auth.length > 512) return null;
        
        const m = /^Bearer[ \t]+([^\s,]+)\s*$/i.exec(auth);
        if (m) key = m[1];
    }

    if (!key && h["x-api-key"]) key = String(h["x-api-key"]).trim();
    if (!key && h["x-openrouter-api-key"]) key = String(h["x-openrouter-api-key"]).trim();

    if (key && (/[\r\n]/.test(key) || key.length > 256)) return null;

    return key || null;
}

function windowReset(now, sizeMs) {
    return now - (now % sizeMs) + sizeMs;
}

function setRLHeaders(res, entry) {
    res.setHeader("x-ratelimit-limit-minute", String(RL_PER_MINUTE));
    res.setHeader("x-ratelimit-remaining-minute", String(Math.max(0, RL_PER_MINUTE - entry.mCount)));
    res.setHeader("x-ratelimit-reset-minute", String(Math.ceil(entry.mReset / 1000)));
    res.setHeader("x-ratelimit-limit-30m", String(RL_PER_30MIN));
    res.setHeader("x-ratelimit-remaining-30m", String(Math.max(0, RL_PER_30MIN - entry.hCount)));
    res.setHeader("x-ratelimit-reset-30m", String(Math.ceil(entry.hReset / 1000)));
}

function ensureEntry(key, now) {
    let e = rlStore.get(key);
    if (!e) {
        e = {
            mCount: 0,
            mReset: windowReset(now, MINUTE_MS),
            hCount: 0,
            hReset: windowReset(now, THIRTY_MIN_MS),
            lastSeen: now
        };
        rlStore.set(key, e);
        return e;
    }
    if (now >= e.mReset) {
        e.mCount = 0;
        e.mReset = windowReset(now, MINUTE_MS);
    }
    if (now >= e.hReset) {
        e.hCount = 0;
        e.hReset = windowReset(now, THIRTY_MIN_MS);
    }
    return e;
}

function evictIfNeeded(now) {
    if (rlStore.size <= RL_MAX_KEYS) return;
    let extras = rlStore.size - RL_MAX_KEYS;
    for (const [k, e] of rlStore) {
        if (extras <= 0) break;
        if (now >= e.hReset && now - e.lastSeen > THIRTY_MIN_MS) {
            rlStore.delete(k);
            extras--;
        }
    }
    while (extras > 0 && rlStore.size > 0) {
        let oldestKey = null;
        let oldestT = Infinity;
        for (const [k, e] of rlStore) {
            if (e.lastSeen < oldestT) {
                oldestT = e.lastSeen;
                oldestKey = k;
            }
        }
        if (oldestKey) {
            rlStore.delete(oldestKey);
            extras--;
        } else {
            break;
        }
    }
}

setInterval(() => {
    const now = Date.now();
    for (const [k, e] of rlStore) {
        if (now >= e.hReset && now - e.lastSeen > THIRTY_MIN_MS) rlStore.delete(k);
    }
    evictIfNeeded(now);
}, RL_SWEEP_MS).unref();

function applyRateLimit(req, res) {
    if (req.method === "OPTIONS") return true;
    const apiKey = getApiKey(req);
    if (!apiKey) {
        res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
        res.end("Missing API key");
        return false;
    }
    if (apiKey.length > 256) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end("Invalid API key");
        return false;
    }
    const now = Date.now();
    const entry = ensureEntry(apiKey, now);
    const nextM = entry.mCount + 1;
    const nextH = entry.hCount + 1;
    const allowed = nextM <= RL_PER_MINUTE && nextH <= RL_PER_30MIN;
    if (!allowed) {
        setRLHeaders(res, entry);
        const retryMs = Math.max(0, Math.min(entry.mReset - now, entry.hReset - now));
        res.writeHead(429, { "content-type": "text/plain; charset=utf-8", "retry-after": String(Math.ceil(retryMs / 1000)) });
        res.end("Too Many Requests");
        return false;
    }
    entry.mCount = nextM;
    entry.hCount = nextH;
    entry.lastSeen = now;
    setRLHeaders(res, entry);
    evictIfNeeded(now);
    return true;
}

function parseExtra(str) {
    const parts = str.split("$");
    const result = {};
    if (parts.length === 0) return result;
    result.model = parts[0];
    for (let i = 1; i < parts.length; i++) {
        const [key, val] = parts[i].split("_");
        if (key && val !== undefined) result[key] = val;
    }
    return result;
}

function getBody(req) {
    return new Promise((resolve, reject) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => resolve(data));
        req.on("error", reject);
    });
}

function forwardRequest(req, res, targetPath = req.url, isStreaming = false) {
    const options = {
        hostname: "openrouter.ai",
        path: `/api${targetPath}`,
        method: req.method,
        headers: {
            ...req.headers,
            host: "openrouter.ai"
        },
        rejectUnauthorized: false
    };
    const forwardReq = https.request(options, (forwardRes) => {
        const responseHeaders = { ...forwardRes.headers };
        if (isStreaming) {
            responseHeaders["cache-control"] = "no-cache";
            responseHeaders["connection"] = "keep-alive";
        }
        res.writeHead(forwardRes.statusCode, responseHeaders);
        if (isStreaming) {
            forwardRes.pipe(res, { end: true });
        } else {
            forwardRes.on("data", (chunk) => res.write(chunk));
            forwardRes.on("end", () => res.end());
        }
        forwardRes.on("error", (err) => {
            if (!res.headersSent) {
                res.writeHead(500);
            }
            if (!res.destroyed) {
                res.end("Internal Server Error");
            }
        });
    });
    forwardReq.on("error", (err) => {
        if (!res.headersSent) {
            res.writeHead(500);
        }
        if (!res.destroyed) {
            res.end("Internal Server Error");
        }
    });
    return forwardReq;
}

http.createServer(async (req, res) => {
    if (req.url.startsWith("/v1/")) {
        if (!applyRateLimit(req, res)) return;
    }
    if (req.url === "/v1/chat/completions" && req.method === "POST") {
        try {
            const bodyStr = await getBody(req);
            let body;
            try {
                body = JSON.parse(bodyStr);
            } catch {
                res.writeHead(400);
                return res.end("Invalid JSON");
            }
            const isStreaming = body.stream === true;
            if (body.model && body.model.includes("$")) {
                const extra = parseExtra(body.model);
                body = { ...body, ...extra };
            }
            const forwardReq = forwardRequest(req, res, req.url, isStreaming);
            forwardReq.setHeader("content-length", Buffer.byteLength(JSON.stringify(body)));
            forwardReq.write(JSON.stringify(body));
            forwardReq.end();
        } catch (err) {
            res.writeHead(500);
            res.end("Internal Server Error");
        }
    } else if (req.url.startsWith("/v1/")) {
        try {
            const forwardReq = forwardRequest(req, res);
            if (req.method === "POST" || req.method === "PUT") {
                const bodyStr = await getBody(req);
                if (bodyStr) {
                    forwardReq.setHeader("content-length", Buffer.byteLength(bodyStr));
                    forwardReq.write(bodyStr);
                }
            }
            forwardReq.end();
        } catch (err) {
            res.writeHead(500);
            res.end("Internal Server Error");
        }
    } else {
        res.writeHead(404);
        res.end("Not Found");
    }
}).listen(8181, () => console.log("OpenRouter proxy running on :8181"));