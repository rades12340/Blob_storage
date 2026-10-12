import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createRoutes } from "./routes";

const rootDir = join(import.meta.dir, "..");

export function startServer({
    port = 3000,
    uploadDir = join(rootDir, "uploads"),
}: {
    port?: number;
    uploadDir?: string;
} = {}) {
    mkdirSync(uploadDir, { recursive: true });

    return Bun.serve({
        port,
        routes: createRoutes({ rootDir, uploadDir }),

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
