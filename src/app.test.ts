import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./app";

const createdDirs: string[] = [];

afterEach(async () => {
    await Promise.all(
        createdDirs
            .splice(0)
            .map((dir) => rm(dir, { recursive: true, force: true })),
    );
});

test("uploads a large file, serves it back, and rejects tampered content", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bun-upload-test-"));
    createdDirs.push(tempDir);

    const server = startServer({ port: 0, uploadDir: tempDir });

    const payload = new Uint8Array(1024 * 64 + 7);
    for (let i = 0; i < payload.length; i++) {
        payload[i] = (i * 31 + 7) % 251;
    }

    const formData = new FormData();
    formData.set(
        "file",
        new Blob([payload], { type: "application/octet-stream" }),
        "sample.bin",
    );

    const uploadResponse = await fetch(
        `http://127.0.0.1:${server.port}/upload`,
        {
            method: "POST",
            body: formData,
        },
    );

    expect(uploadResponse.status).toBe(200);
    const uploadBody = await uploadResponse.json();
    expect(uploadBody.name).toBe("sample.bin");
    expect(uploadBody.size).toBe(payload.byteLength);
    expect(uploadBody.sha256).toBe(
        createHash("sha256").update(payload).digest("hex"),
    );

    const downloadResponse = await fetch(
        `http://127.0.0.1:${server.port}/download/${uploadBody.id}`,
    );
    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.headers.get("x-file-sha256")).toBe(
        uploadBody.sha256,
    );
    expect(new Uint8Array(await downloadResponse.arrayBuffer())).toEqual(
        payload,
    );

    const storagePath = join(tempDir, `${uploadBody.id}.bin`);
    await Bun.write(storagePath, new Uint8Array([...payload, 0x00]));

    const tamperedResponse = await fetch(
        `http://127.0.0.1:${server.port}/download/${uploadBody.id}`,
    );
    expect(tamperedResponse.status).toBe(409);

    server.stop(true);
});
