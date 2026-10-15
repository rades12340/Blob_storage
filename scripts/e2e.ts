// End-to-end check of Blob_storage running against a real auth_service and S3.
// Start all three first (see "End-to-end check" in the README), then: bun run e2e
import { generateKeyPair, SignJWT } from "jose";

const AUTH = process.env.E2E_AUTH_URL ?? "http://localhost:4000";
const BLOB = process.env.E2E_BLOB_URL ?? "http://localhost:3000";
const AUDIENCE = process.env.AUTH_AUDIENCE ?? "blob_storage";
const ORIGIN = process.env.CORS_ORIGIN ?? "http://localhost:5173";
// Must match the server's MAX_UPLOAD_BYTES; the oversize upload is one byte more.
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_BYTES ?? 26214400);
// Optional: S3 base URL and bucket, to check the objects landed under files/<user>/.
const S3_URL = process.env.E2E_S3_URL;
const S3_BUCKET = process.env.S3_BUCKET ?? "blobs";

let failed = 0;
function check(name: string, expected: unknown, actual: unknown) {
    const ok = expected === actual;
    if (!ok) failed++;
    console.log(
        `${ok ? "PASS" : "FAIL"}  ${name}  (expected ${expected}, got ${actual})`,
    );
}

async function post(path: string, body: unknown) {
    return fetch(`${AUTH}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
}

async function sha256(bytes: Uint8Array) {
    return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function upload(
    token: string | null,
    bytes: Uint8Array<ArrayBuffer>,
    name: string,
) {
    const form = new FormData();
    form.append("file", new Blob([bytes]), name);
    return fetch(`${BLOB}/upload`, {
        method: "POST",
        headers: token ? { authorization: `Bearer ${token}` } : {},
        body: form,
    });
}

function download(token: string, id: string) {
    return fetch(`${BLOB}/download/${id}`, {
        headers: { authorization: `Bearer ${token}` },
    });
}

// Unique emails so the script can be re-run against the same database.
const run = Date.now();
const password = "password123";
const alice = `alice+${run}@example.com`;
const bob = `bob+${run}@example.com`;

// --- auth_service ---
check(
    "register alice",
    201,
    (await post("/register", { email: alice, password })).status,
);
check(
    "register bob",
    201,
    (await post("/register", { email: bob, password })).status,
);
check(
    "register duplicate",
    409,
    (await post("/register", { email: alice, password })).status,
);
check(
    "login with wrong password",
    401,
    (await post("/login", { email: alice, password: "wrong-password" })).status,
);

const aliceToken: string = (
    await (await post("/login", { email: alice, password })).json()
).accessToken;
const bobToken: string = (
    await (await post("/login", { email: bob, password })).json()
).accessToken;
check("login returns a token", true, typeof aliceToken === "string");

const jwks = await (await fetch(`${AUTH}/.well-known/jwks.json`)).json();
check("JWKS has a key", true, Array.isArray(jwks.keys) && jwks.keys.length > 0);

const me = await fetch(`${AUTH}/me`, {
    headers: { authorization: `Bearer ${aliceToken}` },
});
const aliceId: string = (await me.json()).id;
check("GET /me", 200, me.status);

// --- token checks on Blob_storage ---
const tiny = new Uint8Array([1, 2, 3]);
check("upload without token", 401, (await upload(null, tiny, "a.bin")).status);
check(
    "upload with garbage token",
    401,
    (await upload("not-a-jwt", tiny, "a.bin")).status,
);

// Correct claims, but signed with a key auth_service never published.
const { privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
const forged = await new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA", kid: jwks.keys[0]?.kid })
    .setIssuer(AUTH)
    .setAudience(AUDIENCE)
    .setSubject(aliceId)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
check(
    "upload with forged-key token",
    401,
    (await upload(forged, tiny, "a.bin")).status,
);

// --- upload and download ---
check(
    "upload over MAX_UPLOAD_BYTES",
    413,
    (await upload(aliceToken, new Uint8Array(MAX_UPLOAD + 1), "big.bin"))
        .status,
);

// getRandomValues fills at most 64 KiB per call.
const bytes = new Uint8Array(1_000_000);
for (let i = 0; i < bytes.length; i += 65536) {
    crypto.getRandomValues(bytes.subarray(i, i + 65536));
}
const uploaded = await upload(aliceToken, bytes, "small.bin");
check("upload 1 MB file", 200, uploaded.status);
const record = await uploaded.json();
check("upload sha256 matches", await sha256(bytes), record.sha256);

const link = await download(aliceToken, record.id);
check("GET /download/:id", 200, link.status);
const { url } = await link.json();
const file = await fetch(url);
check("presigned link works", 200, file.status);
check(
    "downloaded sha256 matches",
    record.sha256,
    await sha256(new Uint8Array(await file.arrayBuffer())),
);
check(
    "content-disposition",
    "attachment; filename*=UTF-8''small.bin",
    file.headers.get("content-disposition"),
);

check(
    "bob downloads alice's file",
    404,
    (await download(bobToken, record.id)).status,
);
check(
    "unknown id",
    404,
    (await download(aliceToken, crypto.randomUUID())).status,
);

const preflight = await fetch(`${BLOB}/upload`, {
    method: "OPTIONS",
    headers: {
        origin: ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization",
    },
});
check(
    "CORS allow-origin",
    ORIGIN,
    preflight.headers.get("access-control-allow-origin"),
);

if (S3_URL) {
    const key = `${S3_URL}/${S3_BUCKET}/files/${aliceId}/${record.id}`;
    check(
        "S3 has the file",
        200,
        (await fetch(key, { method: "HEAD" })).status,
    );
    check(
        "S3 has the record",
        200,
        (await fetch(`${key}.json`, { method: "HEAD" })).status,
    );
}

console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
