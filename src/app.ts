import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createRemoteJWKSet } from "jose";
import { createVerifier, type Verify } from "./auth";
import { createRoutes } from "./routes";

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

export function startServer({
    port = 3000,
    uploadDir = join(rootDir, "uploads"),
    verify = verifierFromEnv(),
    corsOrigin = process.env.CORS_ORIGIN ?? "http://localhost:5173",
}: {
    port?: number;
    uploadDir?: string;
    verify?: Verify;
    corsOrigin?: string;
} = {}) {
    mkdirSync(uploadDir, { recursive: true });

    return Bun.serve({
        port,
        routes: createRoutes({ rootDir, uploadDir, verify, corsOrigin }),

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
