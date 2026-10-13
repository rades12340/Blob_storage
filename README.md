# js_practice

A personal sandbox for practicing JavaScript/TypeScript with [Bun](https://bun.com). It holds a few small, independent experiments rather than one finished app.

## Requirements

- Bun v1.3 or newer

## Getting started

```bash
bun install   # install dependencies
bun run dev   # start the dev server with --watch (runs src/app.ts)
```

Then open http://localhost:3000.

## Project layout

| Path | What it is |
| --- | --- |
| `src/app.ts` | `Bun.serve()` server exported as `startServer({ port, uploadDir })`. Any unmatched path serves `index.html`. |
| `src/routes.ts` | Route table for the server: `/styles.css` and the file upload/download API (see below). |
| `index.html`, `styles.css` | Static "Six things in a row" demo page (a row of six items plus a stack of avatars). |
| `src/worker.ts` | Web Worker that counts the prime numbers up to a given `limit` and posts back `{ limit, primes, ms }`. Nothing uses it yet. |
| `src/app.test.ts` | End-to-end test for upload, download, and tamper detection. |
| `uploads/` | Default storage for uploaded files (`<id>.bin` + `<id>.json` metadata). Created on startup and ignored by git. |
| `context/summarize.md` | Notes summarizing the work done in this repo so far. |
| `.husky/`, `.github/workflows/ci.yml` | Git hooks and CI (see [Checks](#checks)). |

## File API

| Method & path | Description |
| --- | --- |
| `POST /upload` | Multipart form with a `file` field. Returns `{ id, name, size, sha256 }`. |
| `GET /download/:id` | Returns the file with an `x-file-sha256` header. Responds `409` if the stored file no longer matches its recorded hash, `404` if the id is unknown. |

```bash
curl -F file=@some.pdf http://localhost:3000/upload
curl -OJ http://localhost:3000/download/<id>
```

## Using the prime worker

```ts
const worker = new Worker(new URL("./worker.ts", import.meta.url));
worker.onmessage = (e) => console.log(e.data); // { limit, primes, ms }
worker.postMessage({ limit: 1_000_000 });
```

## Checks

| Command | What it does |
| --- | --- |
| `bun test` | Runs the tests. |
| `bun run typecheck` | Type-checks with `tsc --noEmit`. |
| `bun run lint` | Lint and format check with Biome. |
| `bun run lint:fix` | Same, applying fixes. |

These run automatically as well:

- **pre-commit** (Husky): `lint-staged` runs Biome on staged files.
- **pre-push** (Husky): typecheck and tests.
- **CI** (GitHub Actions, on pushes to `main` and on pull requests): Biome, typecheck and tests.

## Known issues

- Uploads are read fully into memory before being written to disk, so very large files use a lot of RAM.
- `.claude/skills/authentication/SKILL.md` is still the empty template; its instructions haven't been written.
