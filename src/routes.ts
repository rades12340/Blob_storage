import { join } from "node:path";

const idPattern = /^[0-9a-f-]{36}$/;

type StoredFile = { id: string; name: string; size: number; sha256: string };

export function createRoutes({
    rootDir,
    uploadDir,
}: {
    rootDir: string;
    uploadDir: string;
}) {
    const dataPath = (id: string) => join(uploadDir, `${id}.bin`);
    const metaPath = (id: string) => join(uploadDir, `${id}.json`);

    return {
        "/styles.css": new Response(Bun.file(join(rootDir, "styles.css")), {
            headers: { "Content-Type": "text/css" },
        }),

        "/upload": {
            POST: async (request: Request) => {
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
                    name: file.name,
                    size: bytes.byteLength,
                    sha256: new Bun.CryptoHasher("sha256")
                        .update(bytes)
                        .digest("hex"),
                };

                await Bun.write(dataPath(meta.id), bytes);
                await Bun.write(metaPath(meta.id), JSON.stringify(meta));

                return Response.json(meta);
            },
        },

        "/download/:id": {
            GET: async (request: Bun.BunRequest<"/download/:id">) => {
                const { id } = request.params;
                const metaFile = Bun.file(metaPath(id));
                if (!idPattern.test(id) || !(await metaFile.exists())) {
                    return Response.json(
                        { error: "Not found" },
                        { status: 404 },
                    );
                }

                const meta: StoredFile = await metaFile.json();
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
        },
    };
}
