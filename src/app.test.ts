import { afterEach, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
    type CryptoKey,
    createLocalJWKSet,
    createRemoteJWKSet,
    exportJWK,
    generateKeyPair,
    SignJWT,
} from "jose";
import { startServer } from "./app";
import { createVerifier, type Verify } from "./auth";
import { createLogger } from "./log";
import { createMemoryStore, fileKey } from "./storage";

const ISSUER = "http://auth.test";
const AUDIENCE = "blob_storage";

const servers: ReturnType<typeof startServer>[] = [];
let privateKey: CryptoKey;
let verify: Verify;

// Stands in for auth_service: a key pair whose public half is served as a
// local JWKS, so no auth server needs to run.
beforeAll(async () => {
    const pair = await generateKeyPair("EdDSA");
    privateKey = pair.privateKey;
    const publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "test" };
    verify = createVerifier({
        keys: createLocalJWKSet({ keys: [publicJwk] }),
        issuer: ISSUER,
        audience: AUDIENCE,
    });
});

afterEach(() => {
    for (const server of servers.splice(0)) server.stop(true);
});

function signToken(
    userId: string,
    { expiresIn = "5m", audience = AUDIENCE } = {},
) {
    return new SignJWT({})
        .setProtectedHeader({ alg: "EdDSA", kid: "test" })
        .setSubject(userId)
        .setIssuer(ISSUER)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime(expiresIn)
        .sign(privateKey);
}

type LogLine = Record<string, unknown> & { message: string };

function setup(
    options: { maxUploadBytes?: number; verify?: Verify; level?: string } = {},
) {
    const store = createMemoryStore();
    const raw: string[] = [];
    const server = startServer({
        port: 0,
        store,
        verify: options.verify ?? verify,
        corsOrigin: "http://app.test",
        maxUploadBytes: options.maxUploadBytes,
        log: createLogger({
            service: "blob",
            level: options.level ?? "debug",
            write: (line) => raw.push(line),
        }),
    });
    servers.push(server);
    const lines = () => raw.map((line) => JSON.parse(line) as LogLine);
    const find = (message: string) =>
        lines().filter((line) => line.message === message);
    return {
        server,
        store,
        raw,
        lines,
        find,
        base: `http://127.0.0.1:${server.port}`,
    };
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

function upload(
    base: string,
    payload: Uint8Array<ArrayBuffer>,
    token?: string,
    name = "sample.bin",
) {
    const formData = new FormData();
    formData.set(
        "file",
        new Blob([payload], { type: "application/octet-stream" }),
        name,
    );
    return fetch(`${base}/upload`, {
        method: "POST",
        body: formData,
        headers: token ? bearer(token) : {},
    });
}

test("uploads to the store and hands out a signed download URL", async () => {
    const { server, store, base } = setup();
    const token = await signToken("user-1");

    const payload = new Uint8Array(1024 * 64 + 7);
    for (let i = 0; i < payload.length; i++) {
        payload[i] = (i * 31 + 7) % 251;
    }

    const uploadResponse = await upload(base, payload, token);

    expect(uploadResponse.status).toBe(200);
    const uploadBody = await uploadResponse.json();
    expect(uploadBody.name).toBe("sample.bin");
    expect(uploadBody.ownerId).toBe("user-1");
    expect(uploadBody.size).toBe(payload.byteLength);
    expect(uploadBody.type).toBe("application/octet-stream");
    expect(uploadBody.sha256).toBe(
        createHash("sha256").update(payload).digest("hex"),
    );

    const key = fileKey("user-1", uploadBody.id);
    const stored = store.objects.get(key);
    expect(stored?.data).toEqual(payload);
    expect(stored?.contentDisposition).toBe(
        "attachment; filename*=UTF-8''sample.bin",
    );
    expect(store.objects.has(`${key}.json`)).toBe(true);

    const downloadResponse = await fetch(`${base}/download/${uploadBody.id}`, {
        headers: bearer(token),
    });
    expect(downloadResponse.status).toBe(200);
    const download = await downloadResponse.json();
    expect(download.url).toBe(`memory://${key}?expiresIn=300`);
    expect(download.name).toBe("sample.bin");
    expect(download.size).toBe(payload.byteLength);
    expect(download.sha256).toBe(uploadBody.sha256);
    expect(Date.parse(download.expiresAt)).toBeGreaterThan(Date.now());

    server.stop(true);
});

test("rejects files over the size limit", async () => {
    const { server, store, base } = setup({ maxUploadBytes: 10 });

    const response = await upload(
        base,
        new Uint8Array(11),
        await signToken("u"),
    );
    expect(response.status).toBe(413);
    expect(store.objects.size).toBe(0);

    server.stop(true);
});

test("returns 502 when the store is unavailable", async () => {
    const { server, store, base, find } = setup();
    store.put = () => Promise.reject(new Error("S3 down"));

    const response = await upload(
        base,
        new Uint8Array([1]),
        await signToken("u"),
    );
    expect(response.status).toBe(502);

    store.readJson = () => Promise.reject(new Error("S3 down"));
    const download = await fetch(`${base}/download/${crypto.randomUUID()}`, {
        headers: bearer(await signToken("u")),
    });
    expect(download.status).toBe(502);

    store.list = () => Promise.reject(new Error("S3 down"));
    const list = await fetch(`${base}/files`, {
        headers: bearer(await signToken("u")),
    });
    expect(list.status).toBe(502);

    const failures = find("storage request failed");
    expect(failures.map((line) => line.operation)).toEqual([
        "put",
        "get",
        "list",
    ]);
    for (const line of failures) {
        expect(line.level).toBe("error");
        expect(line.error).toBe("Error: S3 down");
        expect(line.requestId).toBeString();
    }

    server.stop(true);
});

test("lists only the caller's files, newest first", async () => {
    const { server, base } = setup();
    const owner = await signToken("owner");
    const other = await signToken("other");

    const listNames = async (token: string) => {
        const response = await fetch(`${base}/files`, {
            headers: bearer(token),
        });
        expect(response.status).toBe(200);
        const { files } = await response.json();
        return files.map((file: { name: string }) => file.name);
    };

    expect(await listNames(owner)).toEqual([]);

    await upload(base, new Uint8Array([1]), owner, "first.txt");
    await Bun.sleep(5);
    await upload(base, new Uint8Array([2]), owner, "second.txt");
    await upload(base, new Uint8Array([3]), other, "theirs.txt");

    expect(await listNames(owner)).toEqual(["second.txt", "first.txt"]);
    expect(await listNames(other)).toEqual(["theirs.txt"]);
    expect((await fetch(`${base}/files`)).status).toBe(401);

    server.stop(true);
});

test("a user whose id prefixes another's sees only their own files", async () => {
    const { server, base } = setup();
    await upload(base, new Uint8Array([1]), await signToken("ab"), "ab.txt");

    const response = await fetch(`${base}/files`, {
        headers: bearer(await signToken("a")),
    });
    expect((await response.json()).files).toEqual([]);

    server.stop(true);
});

test("returns 404 for unknown or malformed ids", async () => {
    const { server, base } = setup();
    const token = await signToken("u");

    for (const id of [crypto.randomUUID(), "not-an-id", "..%2F..%2Fx"]) {
        const response = await fetch(`${base}/download/${id}`, {
            headers: bearer(token),
        });
        expect(response.status).toBe(404);
    }

    server.stop(true);
});

test("fileKey keeps a user inside their own prefix", () => {
    expect(fileKey("a/b", "id")).toBe("files/a%2Fb/id");
    expect(fileKey("..", "id")).toBe("files/%2E%2E/id");
});

test("rejects missing, expired and wrong-audience tokens", async () => {
    const { server, base } = setup();
    const payload = new Uint8Array([1, 2, 3]);

    expect((await upload(base, payload)).status).toBe(401);
    expect((await upload(base, payload, "not-a-jwt")).status).toBe(401);
    expect(
        (
            await upload(
                base,
                payload,
                await signToken("u", { expiresIn: "-1s" }),
            )
        ).status,
    ).toBe(401);
    expect(
        (
            await upload(
                base,
                payload,
                await signToken("u", { audience: "todos_service" }),
            )
        ).status,
    ).toBe(401);

    const ok = await upload(base, payload, await signToken("u"));
    const { id } = await ok.json();
    expect((await fetch(`${base}/download/${id}`)).status).toBe(401);

    server.stop(true);
});

test("users can't download each other's files", async () => {
    const { server, base } = setup();
    const owner = await signToken("owner");
    const other = await signToken("other");

    const { id } = await (
        await upload(base, new Uint8Array([9, 9, 9]), owner)
    ).json();

    const response = await fetch(`${base}/download/${id}`, {
        headers: bearer(other),
    });
    expect(response.status).toBe(404);

    server.stop(true);
});

test("CORS preflight allows the frontend origin and the Authorization header", async () => {
    const { server, base } = setup();

    const response = await fetch(`${base}/upload`, { method: "OPTIONS" });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
        "http://app.test",
    );
    expect(response.headers.get("access-control-allow-headers")).toContain(
        "Authorization",
    );

    const unauthorized = await upload(base, new Uint8Array([1]));
    expect(unauthorized.headers.get("access-control-allow-origin")).toBe(
        "http://app.test",
    );

    server.stop(true);
});

const requestIdOf = (response: Response) =>
    response.headers.get("x-request-id");

test("echoes a valid X-Request-Id and tags every line with it", async () => {
    const { server, base, lines } = setup();

    const response = await fetch(`${base}/files`, {
        headers: {
            ...bearer(await signToken("u")),
            "X-Request-Id": "gw-123.abc_DEF",
        },
    });
    expect(response.status).toBe(200);
    expect(requestIdOf(response)).toBe("gw-123.abc_DEF");
    expect(lines().length).toBeGreaterThan(0);
    for (const line of lines()) expect(line.requestId).toBe("gw-123.abc_DEF");

    server.stop(true);
});

test("generates a request id when it's missing or invalid", async () => {
    const { server, base, find } = setup();
    const uuid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

    const missing = await fetch(`${base}/upload`, { method: "OPTIONS" });
    expect(requestIdOf(missing)).toMatch(uuid);

    for (const bad of ["has space", "x".repeat(129), "a/b", '"}{"x":1']) {
        const response = await fetch(`${base}/files`, {
            headers: { "X-Request-Id": bad },
        });
        expect(response.status).toBe(401);
        expect(requestIdOf(response)).toMatch(uuid);
    }

    const ids = find("request").map((line) => line.requestId);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
    for (const id of ids) expect(id).toMatch(uuid);

    server.stop(true);
});

test("sets X-Request-Id on errors and the fallback page too", async () => {
    const { server, base, store, find } = setup();
    store.list = () => Promise.reject(new Error("S3 down"));

    const failed = await fetch(`${base}/files`, {
        headers: { ...bearer(await signToken("u")), "X-Request-Id": "r1" },
    });
    expect(failed.status).toBe(502);
    expect(requestIdOf(failed)).toBe("r1");

    const page = await fetch(`${base}/anything?x=1`, {
        headers: { "X-Request-Id": "r2" },
    });
    expect(page.status).toBe(200);
    expect(requestIdOf(page)).toBe("r2");
    expect(find("request").at(-1)).toMatchObject({ route: "*", status: 200 });

    server.stop(true);
});

test("writes one access line per request with the route pattern", async () => {
    const { server, base, find } = setup();
    const token = await signToken("user-7");
    const { id } = await (
        await upload(base, new Uint8Array([1]), token)
    ).json();

    await fetch(`${base}/download/${id}?secret=1`, { headers: bearer(token) });
    await fetch(`${base}/download/${id}`);

    const access = find("request");
    expect(access).toHaveLength(3);
    expect(access[0]).toMatchObject({
        level: "info",
        service: "blob",
        method: "POST",
        route: "/upload",
        status: 200,
        userId: "user-7",
    });
    expect(access[1]).toMatchObject({
        method: "GET",
        route: "/download/:id",
        status: 200,
        userId: "user-7",
    });
    expect(access[2]).toMatchObject({ route: "/download/:id", status: 401 });
    expect(access[2]).not.toHaveProperty("userId");
    for (const line of access) {
        expect(Number.isInteger(line.ms)).toBe(true);
        expect(Date.parse(String(line.time))).not.toBeNaN();
        expect(JSON.stringify(line)).not.toContain(id);
        expect(JSON.stringify(line)).not.toContain("secret");
    }

    server.stop(true);
});

test("logs uploads, listings, download links and misses", async () => {
    const { server, base, find } = setup();
    const token = await signToken("u1");

    const { id } = await (
        await upload(base, new Uint8Array([1, 2, 3]), token)
    ).json();
    expect(find("file uploaded")).toEqual([
        expect.objectContaining({
            level: "info",
            fileId: id,
            size: 3,
            type: "application/octet-stream",
            userId: "u1",
        }),
    ]);

    await fetch(`${base}/files`, { headers: bearer(token) });
    expect(find("files listed")).toEqual([
        expect.objectContaining({ level: "debug", count: 1, userId: "u1" }),
    ]);

    const link = await (
        await fetch(`${base}/download/${id}`, { headers: bearer(token) })
    ).json();
    expect(find("download link issued")).toEqual([
        expect.objectContaining({
            level: "info",
            fileId: id,
            userId: "u1",
            expiresAt: link.expiresAt,
        }),
    ]);

    const missing = crypto.randomUUID();
    await fetch(`${base}/download/${missing}`, { headers: bearer(token) });
    expect(find("file not found")).toEqual([
        expect.objectContaining({
            level: "info",
            fileId: missing,
            userId: "u1",
        }),
    ]);

    server.stop(true);
});

test("logs why an upload was rejected", async () => {
    const { server, base, find } = setup({ maxUploadBytes: 10 });
    const token = await signToken("u2");

    expect((await upload(base, new Uint8Array(11), token)).status).toBe(413);

    const noFile = new FormData();
    noFile.set("other", "x");
    const missing = await fetch(`${base}/upload`, {
        method: "POST",
        body: noFile,
        headers: bearer(token),
    });
    expect(missing.status).toBe(400);

    const notAForm = await fetch(`${base}/upload`, {
        method: "POST",
        body: "{}",
        headers: { ...bearer(token), "Content-Type": "application/json" },
    });
    expect(notAForm.status).toBe(400);

    const rejected = find("upload rejected");
    expect(rejected.map((line) => line.reason)).toEqual([
        "too large",
        "missing file",
        "bad form",
    ]);
    for (const line of rejected) {
        expect(line.level).toBe("warn");
        expect(line.userId).toBe("u2");
    }

    server.stop(true);
});

test("logs why a token was refused", async () => {
    const { server, base, find } = setup();
    const payload = new Uint8Array([1]);

    await upload(base, payload);
    await upload(base, payload, "not-a-jwt");
    await upload(base, payload, await signToken("u", { expiresIn: "-1s" }));
    await upload(base, payload, await signToken("u", { audience: "other" }));
    const forged = await new SignJWT({})
        .setProtectedHeader({ alg: "EdDSA", kid: "test" })
        .setSubject("u")
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime("5m")
        .sign((await generateKeyPair("EdDSA")).privateKey);
    await upload(base, payload, forged);

    const failed = find("auth failed");
    expect(failed.map((line) => line.reason)).toEqual([
        "missing",
        "malformed",
        "expired",
        "wrong audience",
        "invalid signature",
    ]);
    for (const line of failed) expect(line.level).toBe("warn");

    server.stop(true);
});

test("logs when auth_service's public keys can't be fetched", async () => {
    // Answers 500, like an auth_service that's up but broken.
    const broken = Bun.serve({
        port: 0,
        fetch: () => new Response("nope", { status: 500 }),
    });
    const { server, base, find } = setup({
        verify: createVerifier({
            keys: createRemoteJWKSet(new URL(`${broken.url}jwks.json`)),
            issuer: ISSUER,
            audience: AUDIENCE,
        }),
    });

    const response = await upload(
        base,
        new Uint8Array([1]),
        await signToken("u"),
    );
    expect(response.status).toBe(401);

    const [fetchFailed] = find("public key fetch failed");
    expect(fetchFailed?.level).toBe("error");
    expect(String(fetchFailed?.error)).toContain("200 OK");
    expect(find("auth failed")[0]?.reason).toBe("key fetch failed");

    broken.stop(true);
    server.stop(true);
});

test("never logs the bearer token or the presigned URL", async () => {
    const store = createMemoryStore();
    // A realistic presigned URL, so its signature has something to leak.
    const s3 = new Bun.S3Client({
        bucket: "blobs",
        region: "us-east-1",
        accessKeyId: "AKIDEXAMPLE",
        secretAccessKey: "super-secret-key",
        endpoint: "http://s3.test",
    });
    store.signedUrl = (key, expiresIn) => s3.presign(key, { expiresIn });
    const raw: string[] = [];
    const server = startServer({
        port: 0,
        store,
        verify,
        log: createLogger({
            service: "blob",
            level: "debug",
            write: (line) => raw.push(line),
        }),
    });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const token = await signToken("u3");

    const { id } = await (
        await upload(base, new Uint8Array([7]), token)
    ).json();
    await fetch(`${base}/files`, { headers: bearer(token) });
    const { url } = await (
        await fetch(`${base}/download/${id}?token=${token}`, {
            headers: bearer(token),
        })
    ).json();
    await upload(base, new Uint8Array([7]), `${token}x`);

    expect(url).toContain("X-Amz-Signature");
    const signature = new URL(url).searchParams.get("X-Amz-Signature") ?? "";
    expect(raw.length).toBeGreaterThan(5);
    const all = raw.join("\n");
    expect(all).not.toContain(token);
    expect(all).not.toContain(token.split(".")[2] ?? token);
    expect(all).not.toContain(url);
    expect(all).not.toContain(signature);
    expect(all).not.toContain("X-Amz-Signature");
    expect(all).not.toContain("super-secret-key");
    expect(all.toLowerCase()).not.toContain("authorization");
    expect(all.toLowerCase()).not.toContain("bearer");
});

test("LOG_LEVEL drops lines below the configured level", () => {
    const lines: string[] = [];
    const write = (line: string) => lines.push(line);
    const levels = (level?: string) => {
        lines.length = 0;
        const log = createLogger({ service: "blob", level, write });
        log.debug("d");
        log.info("i");
        log.warn("w");
        log.error("e");
        return lines.map((line) => JSON.parse(line).level);
    };

    expect(levels("debug")).toEqual(["debug", "info", "warn", "error"]);
    expect(levels("info")).toEqual(["info", "warn", "error"]);
    expect(levels("warn")).toEqual(["warn", "error"]);
    expect(levels("error")).toEqual(["error"]);
    expect(levels("nonsense")).toEqual(["info", "warn", "error"]);

    const original = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "warn";
    expect(levels()).toEqual(["warn", "error"]);
    process.env.LOG_LEVEL = original;
    if (original === undefined) delete process.env.LOG_LEVEL;
    expect(levels()).toEqual(["info", "warn", "error"]);
});

test("each line is one JSON object with time, level, service and message", () => {
    const lines: string[] = [];
    const log = createLogger({
        service: "blob",
        level: "info",
        write: (line) => lines.push(line),
    });
    log.info("hello", { requestId: "r", n: 1 });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\n");
    const line = JSON.parse(lines[0] ?? "");
    expect(line).toEqual({
        time: expect.any(String),
        level: "info",
        service: "blob",
        message: "hello",
        requestId: "r",
        n: 1,
    });
    expect(new Date(line.time).toISOString()).toBe(line.time);
});

test("filters by level inside the server too", async () => {
    const { server, base, find } = setup({ level: "warn" });
    await fetch(`${base}/files`, { headers: bearer(await signToken("u")) });
    await fetch(`${base}/files`);

    expect(find("request")).toEqual([]);
    expect(find("files listed")).toEqual([]);
    expect(find("auth failed")).toHaveLength(1);

    server.stop(true);
});
