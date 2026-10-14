import { expect, test } from "bun:test";
import { S3Client } from "bun";
import { createS3Store } from "./storage";

const credentials = {
    bucket: "blobs",
    region: "us-east-1",
    accessKeyId: "test",
    secretAccessKey: "test",
};

test("signs download URLs for the public endpoint when one is given", () => {
    const store = createS3Store(
        new S3Client({ ...credentials, endpoint: "http://s3:9090" }),
        new S3Client({ ...credentials, endpoint: "http://localhost:9090" }),
    );

    const url = new URL(store.signedUrl("files/u/id", 60));
    expect(url.host).toBe("localhost:9090");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("60");
});

test("signs with the main client by default", () => {
    const store = createS3Store(
        new S3Client({ ...credentials, endpoint: "http://s3:9090" }),
    );

    expect(new URL(store.signedUrl("files/u/id", 60)).host).toBe("s3:9090");
});
