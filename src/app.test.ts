import { afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
    type CryptoKey,
    createLocalJWKSet,
    exportJWK,
    generateKeyPair,
    SignJWT,
} from "jose";
import { startServer } from "./app";
import { createVerifier, type Verify } from "./auth";
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

function setup(options: { maxUploadBytes?: number } = {}) {
    const store = createMemoryStore();
    const server = startServer({
        port: 0,
        store,
        verify,
        corsOrigin: "http://app.test",
        ...options,
    });
    servers.push(server);
    return { server, store, base: `http://127.0.0.1:${server.port}` };
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

function upload(
    base: string,
    payload: Uint8Array<ArrayBuffer>,
    token?: string,
) {
    const formData = new FormData();
    formData.set(
        "file",
        new Blob([payload], { type: "application/octet-stream" }),
        "sample.bin",
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
    const { server, store, base } = setup();
    store.put = () => Promise.reject(new Error("S3 down"));
    const consoleError = spyOn(console, "error").mockImplementation(() => {});

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
    expect(consoleError).toHaveBeenCalledTimes(2);

    consoleError.mockRestore();
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
