import type { S3Client } from "bun";

type PutOptions = { type: string; contentDisposition?: string };

// Where files live. The routes only talk to this, so tests can swap S3 for
// an in-memory map.
export type FileStore = {
    put(
        key: string,
        data: Uint8Array | string,
        opts: PutOptions,
    ): Promise<void>;
    // null when the object doesn't exist.
    readJson<T>(key: string): Promise<T | null>;
    // Every key that starts with `prefix`.
    list(prefix: string): Promise<string[]>;
    signedUrl(key: string, expiresIn: number): string;
};

// Every object sits under its owner's prefix, so looking a file up under the
// caller's prefix is also the ownership check. encodeURIComponent leaves "."
// alone, so ".." is escaped by hand to keep it from reading as a path segment.
export function fileKey(ownerId: string, id: string): string {
    const owner = encodeURIComponent(ownerId).replaceAll(".", "%2E");
    return `files/${owner}/${id}`;
}

// `presignClient` signs download URLs. Pass one with a different endpoint
// when clients reach S3 at another address than the server does (e.g. Docker:
// the server uses http://s3:9090, the browser http://localhost:9090).
// Signing is local, so it never makes a request.
export function createS3Store(
    client: S3Client,
    presignClient: S3Client = client,
): FileStore {
    return {
        async put(key, data, opts) {
            await client.write(key, data, opts);
        },
        async readJson(key) {
            const file = client.file(key);
            return (await file.exists()) ? file.json() : null;
        },
        async list(prefix) {
            const keys: string[] = [];
            let continuationToken: string | undefined;
            do {
                const page = await client.list({ prefix, continuationToken });
                for (const object of page.contents ?? []) keys.push(object.key);
                continuationToken = page.isTruncated
                    ? page.nextContinuationToken
                    : undefined;
            } while (continuationToken);
            return keys;
        },
        signedUrl(key, expiresIn) {
            return presignClient.presign(key, { expiresIn, method: "GET" });
        },
    };
}

type MemoryObject = PutOptions & { data: Uint8Array | string };

export function createMemoryStore() {
    const objects = new Map<string, MemoryObject>();
    const store: FileStore & { objects: Map<string, MemoryObject> } = {
        objects,
        async put(key, data, opts) {
            objects.set(key, { data, ...opts });
        },
        async readJson(key) {
            const object = objects.get(key);
            return object ? JSON.parse(String(object.data)) : null;
        },
        async list(prefix) {
            return [...objects.keys()].filter((key) => key.startsWith(prefix));
        },
        signedUrl(key, expiresIn) {
            return `memory://${key}?expiresIn=${expiresIn}`;
        },
    };
    return store;
}
