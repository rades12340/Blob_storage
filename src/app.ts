import { join } from "node:path";
import { S3Client } from "bun";
import { createRemoteJWKSet } from "jose";
import { createVerifier, type Verify } from "./auth";
import { createLogger, type Logger } from "./log";
import { withRequestLog } from "./requestLog";
import { createRoutes } from "./routes";
import { createS3Store, type FileStore } from "./storage";

const rootDir = join(import.meta.dir, "..");

// Defaults match auth_service running locally on port 4000.
function verifierFromEnv(): Verify {
    const authUrl = process.env.AUTH_ISSUER ?? "http://localhost:4000";
    const jwksUrl =
        process.env.AUTH_JWKS_URL ?? `${authUrl}/.well-known/jwks.json`;
    return createVerifier({
        keys: createRemoteJWKSet(new URL(jwksUrl)),
        issuer: authUrl,
        audience: process.env.AUTH_AUDIENCE ?? "blob_storage",
    });
}

// S3Client reads S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY and
// S3_ENDPOINT (or their AWS_* equivalents) from the environment itself.
// S3_PUBLIC_ENDPOINT, if set, is the address clients use to reach S3.
function storeFromEnv(): FileStore {
    if (!process.env.S3_BUCKET && !process.env.AWS_BUCKET) {
        throw new Error(
            "S3_BUCKET is not set. Add the S3_* variables to .env (see README).",
        );
    }
    const publicEndpoint = process.env.S3_PUBLIC_ENDPOINT;
    return createS3Store(
        new S3Client(),
        publicEndpoint ? new S3Client({ endpoint: publicEndpoint }) : undefined,
    );
}

const numberFromEnv = (name: string, fallback: number) =>
    Number(process.env[name]) || fallback;

export function startServer({
    port = 3000,
    store = storeFromEnv(),
    verify = verifierFromEnv(),
    corsOrigin = process.env.CORS_ORIGIN ?? "http://localhost:5173",
    maxUploadBytes = numberFromEnv("MAX_UPLOAD_BYTES", 25 * 1024 * 1024),
    downloadUrlTtl = numberFromEnv("DOWNLOAD_URL_TTL", 300),
    log = createLogger({ service: "blob" }),
}: {
    port?: number;
    store?: FileStore;
    verify?: Verify;
    corsOrigin?: string;
    maxUploadBytes?: number;
    downloadUrlTtl?: number;
    log?: Logger;
} = {}) {
    return Bun.serve({
        port,
        // Room for the multipart envelope around a max-size file.
        maxRequestBodySize: maxUploadBytes + 1024 * 1024,
        routes: createRoutes({
            rootDir,
            store,
            verify,
            log,
            corsOrigin,
            maxUploadBytes,
            downloadUrlTtl,
        }),

        // Everything else gets the upload page.
        fetch: withRequestLog(
            log,
            "*",
            () =>
                new Response(Bun.file(join(rootDir, "index.html")), {
                    headers: { "Content-Type": "text/html" },
                }),
        ),

        development: {
            hmr: true,
            console: true,
        },
    });
}

if (import.meta.main) {
    const log = createLogger({ service: "blob" });
    const server = startServer({ log });
    log.info("listening", { port: server.port });
}
