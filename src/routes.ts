import { join } from "node:path";
import type { Verify } from "./auth";
import { docsRoutes } from "./docs";
import type { Logger } from "./log";
import { type Handler, logRoute, type RequestContext } from "./requestLog";
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
    log,
    corsOrigin,
    maxUploadBytes,
    downloadUrlTtl,
}: {
    rootDir: string;
    store: FileStore;
    verify: Verify;
    log: Logger;
    corsOrigin: string;
    maxUploadBytes: number;
    downloadUrlTtl: number;
}) {
    // Bearer tokens aren't sent automatically by the browser, so no
    // credentials (cookies) are needed and no CSRF protection either.
    const corsHeaders = {
        "Access-Control-Allow-Origin": corsOrigin,
        "Access-Control-Allow-Headers":
            "Authorization, Content-Type, X-Request-Id",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Expose-Headers": "X-Request-Id",
        Vary: "Origin",
    };

    function storageUnavailable(
        ctx: RequestContext,
        operation: string,
        error: unknown,
    ) {
        ctx.log.error("storage request failed", {
            operation,
            error: String(error),
        });
        return Response.json({ error: "Storage unavailable" }, { status: 502 });
    }

    const preflight = () =>
        new Response(null, { status: 204, headers: corsHeaders });

    // Bytes go first and the record last, the reverse of an upload. If a
    // step fails the record is still listed, so the user can retry; a
    // record never outlives its bytes unnoticed.
    async function removeFile(key: string) {
        await store.remove(key);
        await store.remove(`${key}.json`);
    }

    // Runs the handler only for a valid access token, and adds CORS headers
    // to whatever it returns.
    function withAuth<R extends Request>(
        handler: (
            request: R,
            ctx: RequestContext & { userId: string },
        ) => Promise<Response>,
    ): Handler<R> {
        return async (request, ctx) => {
            const auth = await verify(request);
            let response: Response;
            if ("userId" in auth) {
                ctx.userId = auth.userId;
                response = await handler(request, {
                    ...ctx,
                    userId: auth.userId,
                });
            } else {
                if (auth.reason === "key fetch failed") {
                    ctx.log.error("public key fetch failed", {
                        error: auth.error,
                    });
                }
                ctx.log.warn("auth failed", { reason: auth.reason });
                response = Response.json(
                    { error: "Unauthorized" },
                    { status: 401 },
                );
            }
            for (const [name, value] of Object.entries(corsHeaders)) {
                response.headers.set(name, value);
            }
            return response;
        };
    }

    return {
        "/openapi.json": logRoute(
            log,
            "/openapi.json",
            docsRoutes["/openapi.json"],
        ),
        "/docs": logRoute(log, "/docs", docsRoutes["/docs"]),

        "/styles.css": logRoute(log, "/styles.css", {
            GET: () =>
                new Response(Bun.file(join(rootDir, "styles.css")), {
                    headers: { "Content-Type": "text/css" },
                }),
        }),

        "/upload": logRoute(log, "/upload", {
            OPTIONS: preflight,
            POST: withAuth(async (request: Request, ctx) => {
                const { userId } = ctx;
                const form = await request.formData().catch(() => null);
                if (!form) {
                    ctx.log.warn("upload rejected", {
                        reason: "bad form",
                        userId,
                    });
                    return Response.json(
                        { error: "Missing 'file' field" },
                        { status: 400 },
                    );
                }
                const file = form.get("file");
                if (!(file instanceof File)) {
                    ctx.log.warn("upload rejected", {
                        reason: "missing file",
                        userId,
                    });
                    return Response.json(
                        { error: "Missing 'file' field" },
                        { status: 400 },
                    );
                }

                if (file.size > maxUploadBytes) {
                    ctx.log.warn("upload rejected", {
                        reason: "too large",
                        size: file.size,
                        userId,
                    });
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
                    return storageUnavailable(ctx, "put", error);
                }

                ctx.log.info("file uploaded", {
                    fileId: meta.id,
                    size: meta.size,
                    type,
                    userId,
                });
                return Response.json(meta);
            }),
        }),

        "/files": logRoute(log, "/files", {
            OPTIONS: preflight,
            GET: withAuth(async (_request: Request, ctx) => {
                const { userId } = ctx;
                let files: StoredFile[];
                try {
                    // fileKey with an empty id is the caller's own prefix,
                    // so only their records are listed.
                    const keys = await store.list(fileKey(userId, ""));
                    const records = await Promise.all(
                        keys
                            .filter((key) => key.endsWith(".json"))
                            .map((key) => store.readJson<StoredFile>(key)),
                    );
                    files = records.filter((meta) => meta !== null);
                } catch (error) {
                    return storageUnavailable(ctx, "list", error);
                }
                files.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
                ctx.log.debug("files listed", { count: files.length, userId });
                return Response.json({ files });
            }),
            // Erases everything the caller has stored (GDPR right to
            // erasure). auth_service calls this with the user's own token
            // when an account is deleted.
            DELETE: withAuth(async (_request: Request, ctx) => {
                const { userId } = ctx;
                let deleted = 0;
                try {
                    const keys = await store.list(fileKey(userId, ""));
                    const records = keys.filter((key) => key.endsWith(".json"));
                    const recordSet = new Set(records);
                    // Orphaned bytes (an upload that failed before its
                    // record was written) are personal data too.
                    for (const key of keys) {
                        if (!recordSet.has(key)) await store.remove(key);
                    }
                    for (const key of records) {
                        await store.remove(key);
                        deleted++;
                    }
                } catch (error) {
                    ctx.log.error("erasure incomplete", { deleted, userId });
                    return storageUnavailable(ctx, "delete", error);
                }
                ctx.log.info("all files deleted", { count: deleted, userId });
                return Response.json({ deleted });
            }),
        }),

        "/files/:id": logRoute(log, "/files/:id", {
            OPTIONS: preflight,
            DELETE: withAuth(
                async (request: Bun.BunRequest<"/files/:id">, ctx) => {
                    const { userId } = ctx;
                    const { id } = request.params;
                    // As with downloads, someone else's file is a 404.
                    let meta: StoredFile | null = null;
                    try {
                        if (idPattern.test(id)) {
                            meta = await store.readJson<StoredFile>(
                                `${fileKey(userId, id)}.json`,
                            );
                        }
                        if (meta) await removeFile(fileKey(userId, id));
                    } catch (error) {
                        return storageUnavailable(ctx, "delete", error);
                    }
                    if (!meta) {
                        ctx.log.info("file not found", { fileId: id, userId });
                        return Response.json(
                            { error: "Not found" },
                            { status: 404 },
                        );
                    }
                    ctx.log.info("file deleted", {
                        fileId: id,
                        size: meta.size,
                        userId,
                    });
                    return new Response(null, { status: 204 });
                },
            ),
        }),

        "/download/:id": logRoute(log, "/download/:id", {
            OPTIONS: preflight,
            GET: withAuth(
                async (request: Bun.BunRequest<"/download/:id">, ctx) => {
                    const { userId } = ctx;
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
                            return storageUnavailable(ctx, "get", error);
                        }
                    }
                    if (!meta) {
                        ctx.log.info("file not found", { fileId: id, userId });
                        return Response.json(
                            { error: "Not found" },
                            { status: 404 },
                        );
                    }

                    const expiresAt = new Date(
                        Date.now() + downloadUrlTtl * 1000,
                    ).toISOString();
                    // The URL's signature is a credential: log only that
                    // one was issued, never the link itself.
                    ctx.log.info("download link issued", {
                        fileId: id,
                        userId,
                        expiresAt,
                    });
                    return Response.json({
                        url: store.signedUrl(
                            fileKey(userId, id),
                            downloadUrlTtl,
                        ),
                        expiresAt,
                        name: meta.name,
                        size: meta.size,
                        type: meta.type,
                        sha256: meta.sha256,
                    });
                },
            ),
        }),
    };
}
