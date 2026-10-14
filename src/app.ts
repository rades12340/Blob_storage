import { join } from "node:path";
import { S3Client } from "bun";
import { createRemoteJWKSet } from "jose";
import { createVerifier, type Verify } from "./auth";
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
function storeFromEnv(): FileStore {
    if (!process.env.S3_BUCKET && !process.env.AWS_BUCKET) {
        throw new Error(
            "S3_BUCKET is not set. Add the S3_* variables to .env (see README).",
        );
    }
    return createS3Store(new S3Client());
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
}: {
    port?: number;
    store?: FileStore;
    verify?: Verify;
    corsOrigin?: string;
    maxUploadBytes?: number;
    downloadUrlTtl?: number;
} = {}) {
    return Bun.serve({
        port,
        // Room for the multipart envelope around a max-size file.
        maxRequestBodySize: maxUploadBytes + 1024 * 1024,
        routes: createRoutes({
            rootDir,
            store,
            verify,
            corsOrigin,
            maxUploadBytes,
            downloadUrlTtl,
        }),

        fetch() {
            return new Response(Bun.file(join(rootDir, "index.html")), {
                headers: { "Content-Type": "text/html" },
            });
        },

        development: {
            hmr: true,
            console: true,
        },
    });
}

if (import.meta.main) {
    const server = startServer();
    console.log(`Server running at ${server.url}`);
}
