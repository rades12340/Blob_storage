import { join } from "node:path";
import type { Verify } from "./auth";
import { docsRoutes } from "./docs";
import { type FileStore, fileKey } from "./storage";

const idPattern = /^[0-9a-f-]{36}$/;

type StoredFile = {
    id: string;
    ownerId: string;
    name: string;
    size: number;
    type: string;
    sha256: string;
    createdAt: string;
};

export function createRoutes({
    rootDir,
    store,
    verify,
    corsOrigin,
    maxUploadBytes,
    downloadUrlTtl,
}: {
    rootDir: string;
    store: FileStore;
    verify: Verify;
    corsOrigin: string;
    maxUploadBytes: number;
    downloadUrlTtl: number;
}) {
    // Bearer tokens aren't sent automatically by the browser, so no
    // credentials (cookies) are needed and no CSRF protection either.
    const corsHeaders = {
        "Access-Control-Allow-Origin": corsOrigin,
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        Vary: "Origin",
    };

    function storageUnavailable(error: unknown) {
        console.error("Storage request failed", error);
        return Response.json({ error: "Storage unavailable" }, { status: 502 });
    }

    const preflight = () =>
        new Response(null, { status: 204, headers: corsHeaders });

    // Runs the handler only for a valid access token, and adds CORS headers
    // to whatever it returns.
    function withAuth<R extends Request>(
        handler: (request: R, userId: string) => Promise<Response>,
    ) {
        return async (request: R) => {
            const auth = await verify(request);
            const response = auth
                ? await handler(request, auth.userId)
                : Response.json({ error: "Unauthorized" }, { status: 401 });
            for (const [name, value] of Object.entries(corsHeaders)) {
                response.headers.set(name, value);
            }
            return response;
        };
    }

    return {
        ...docsRoutes,

        "/styles.css": new Response(Bun.file(join(rootDir, "styles.css")), {
            headers: { "Content-Type": "text/css" },
        }),

        "/upload": {
            OPTIONS: preflight,
            POST: withAuth(async (request: Request, userId) => {
                const form = await request.formData().catch(() => null);
                const file = form?.get("file");
                if (!(file instanceof File)) {
                    return Response.json(
                        { error: "Missing 'file' field" },
                        { status: 400 },
                    );
                }

                if (file.size > maxUploadBytes) {
                    return Response.json(
                        {
                            error: `File is larger than ${maxUploadBytes} bytes`,
                        },
                        { status: 413 },
                    );
                }

                const bytes = new Uint8Array(await file.arrayBuffer());
                const type = file.type || "application/octet-stream";
                const meta: StoredFile = {
                    id: crypto.randomUUID(),
                    ownerId: userId,
                    name: file.name,
                    size: bytes.byteLength,
                    type,
                    sha256: new Bun.CryptoHasher("sha256")
                        .update(bytes)
                        .digest("hex"),
                    createdAt: new Date().toISOString(),
                };

                const key = fileKey(userId, meta.id);
                try {
                    await store.put(key, bytes, {
                        type,
                        // Makes the presigned link download under the real name.
                        contentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
                    });
                    // Written last, so a record only exists once its bytes do.
                    await store.put(`${key}.json`, JSON.stringify(meta), {
                        type: "application/json",
                    });
                } catch (error) {
                    return storageUnavailable(error);
                }

                return Response.json(meta);
            }),
        },

        "/download/:id": {
            OPTIONS: preflight,
            GET: withAuth(
                async (request: Bun.BunRequest<"/download/:id">, userId) => {
                    const { id } = request.params;
                    // Looking only under the caller's own prefix means
                    // someone else's file looks exactly like a missing one.
                    let meta: StoredFile | null = null;
                    if (idPattern.test(id)) {
                        try {
                            meta = await store.readJson<StoredFile>(
                                `${fileKey(userId, id)}.json`,
                            );
                        } catch (error) {
                            return storageUnavailable(error);
                        }
                    }
                    if (!meta) {
                        return Response.json(
                            { error: "Not found" },
                            { status: 404 },
                        );
                    }

                    return Response.json({
                        url: store.signedUrl(
                            fileKey(userId, id),
                            downloadUrlTtl,
                        ),
                        expiresAt: new Date(
                            Date.now() + downloadUrlTtl * 1000,
                        ).toISOString(),
                        name: meta.name,
                        size: meta.size,
                        type: meta.type,
                        sha256: meta.sha256,
                    });
                },
            ),
        },
    };
}
