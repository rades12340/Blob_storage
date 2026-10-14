import { afterEach, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    type CryptoKey,
    createLocalJWKSet,
    exportJWK,
    generateKeyPair,
    SignJWT,
} from "jose";
import { startServer } from "./app";
import { createVerifier, type Verify } from "./auth";

const ISSUER = "http://auth.test";
const AUDIENCE = "blob_storage";

const createdDirs: string[] = [];
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

afterEach(async () => {
    await Promise.all(
        createdDirs
            .splice(0)
            .map((dir) => rm(dir, { recursive: true, force: true })),
    );
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

async function setup() {
    const tempDir = await mkdtemp(join(tmpdir(), "bun-upload-test-"));
    createdDirs.push(tempDir);
    const server = startServer({
        port: 0,
        uploadDir: tempDir,
        verify,
        corsOrigin: "http://app.test",
    });
    return { server, tempDir, base: `http://127.0.0.1:${server.port}` };
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

test("uploads a large file, serves it back, and rejects tampered content", async () => {
    const { server, tempDir, base } = await setup();
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
    expect(uploadBody.sha256).toBe(
        createHash("sha256").update(payload).digest("hex"),
    );

    const downloadResponse = await fetch(`${base}/download/${uploadBody.id}`, {
        headers: bearer(token),
    });
    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.headers.get("x-file-sha256")).toBe(
        uploadBody.sha256,
    );
    expect(new Uint8Array(await downloadResponse.arrayBuffer())).toEqual(
        payload,
    );

    const storagePath = join(tempDir, `${uploadBody.id}.bin`);
    await Bun.write(storagePath, new Uint8Array([...payload, 0x00]));

    const tamperedResponse = await fetch(`${base}/download/${uploadBody.id}`, {
        headers: bearer(token),
    });
    expect(tamperedResponse.status).toBe(409);

    server.stop(true);
});

test("rejects missing, expired and wrong-audience tokens", async () => {
    const { server, base } = await setup();
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
    const { server, base } = await setup();
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
    const { server, base } = await setup();

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
