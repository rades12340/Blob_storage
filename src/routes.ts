import { join } from "node:path";
import type { Verify } from "./auth";

const idPattern = /^[0-9a-f-]{36}$/;

type StoredFile = {
    id: string;
    ownerId: string;
    name: string;
    size: number;
    sha256: string;
};

export function createRoutes({
    rootDir,
    uploadDir,
    verify,
    corsOrigin,
}: {
    rootDir: string;
    uploadDir: string;
    verify: Verify;
    corsOrigin: string;
}) {
    const dataPath = (id: string) => join(uploadDir, `${id}.bin`);
    const metaPath = (id: string) => join(uploadDir, `${id}.json`);

    // Bearer tokens aren't sent automatically by the browser, so no
    // credentials (cookies) are needed and no CSRF protection either.
    const corsHeaders = {
        "Access-Control-Allow-Origin": corsOrigin,
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Expose-Headers": "Content-Disposition, x-file-sha256",
        Vary: "Origin",
    };

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

                const bytes = new Uint8Array(await file.arrayBuffer());
                const meta: StoredFile = {
                    id: crypto.randomUUID(),
                    ownerId: userId,
                    name: file.name,
                    size: bytes.byteLength,
                    sha256: new Bun.CryptoHasher("sha256")
                        .update(bytes)
                        .digest("hex"),
                };

                await Bun.write(dataPath(meta.id), bytes);
                await Bun.write(metaPath(meta.id), JSON.stringify(meta));

                return Response.json(meta);
            }),
        },

        "/download/:id": {
            OPTIONS: preflight,
            GET: withAuth(
                async (request: Bun.BunRequest<"/download/:id">, userId) => {
                    const { id } = request.params;
                    const metaFile = Bun.file(metaPath(id));
                    const meta: StoredFile | null =
                        idPattern.test(id) && (await metaFile.exists())
                            ? await metaFile.json()
                            : null;
                    // Someone else's file looks exactly like a missing one.
                    if (!meta || meta.ownerId !== userId) {
                        return Response.json(
                            { error: "Not found" },
                            { status: 404 },
                        );
                    }

                    const bytes = await Bun.file(dataPath(id)).bytes();
                    const sha256 = new Bun.CryptoHasher("sha256")
                        .update(bytes)
                        .digest("hex");
                    if (sha256 !== meta.sha256) {
                        return Response.json(
                            { error: "Stored file failed integrity check" },
                            { status: 409 },
                        );
                    }

                    return new Response(bytes, {
                        headers: {
                            "Content-Type": "application/octet-stream",
                            "Content-Disposition": `attachment; filename="${encodeURIComponent(meta.name)}"`,
                            "x-file-sha256": sha256,
                        },
                    });
                },
            ),
        },
    };
}
