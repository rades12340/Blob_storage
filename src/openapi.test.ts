import { expect, test } from "bun:test";
import spec from "../openapi.yaml";
import { createRoutes } from "./routes";
import { createMemoryStore } from "./storage";

// Served for people, not part of the API, so not in the spec.
const UNDOCUMENTED = new Set(["/styles.css", "/docs", "/openapi.json"]);
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

const routes = createRoutes({
    rootDir: ".",
    store: createMemoryStore(),
    verify: async () => null,
    corsOrigin: "http://app.test",
    maxUploadBytes: 1024,
    downloadUrlTtl: 60,
});

test("the spec documents exactly the routes the server has", () => {
    const served = Object.entries(routes)
        .filter(([path]) => !UNDOCUMENTED.has(path))
        .flatMap(([path, handlers]) =>
            Object.keys(handlers)
                .filter((method) => HTTP_METHODS.includes(method))
                .map(
                    (method) => `${method} ${path.replace(/:(\w+)/g, "{$1}")}`,
                ),
        );
    const documented = Object.entries(
        spec.paths as Record<string, object>,
    ).flatMap(([path, operations]) =>
        Object.keys(operations).map(
            (method) => `${method.toUpperCase()} ${path}`,
        ),
    );

    expect(documented.sort()).toEqual(served.sort());
});

test("serves the spec as JSON and a Swagger UI page", async () => {
    const json = await routes["/openapi.json"].GET();
    expect(json.status).toBe(200);
    expect((await json.json()).openapi).toStartWith("3.1");

    const page = await routes["/docs"].GET();
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("SwaggerUIBundle");
});
