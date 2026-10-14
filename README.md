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
| `src/app.ts` | `Bun.serve()` server exported as `startServer({ port, uploadDir })`. Serves the demo page plus a file upload/download API (see below). |
| `index.html`, `styles.css` | Static "Six things in a row" demo page (a row of six items plus a stack of avatars). |
| `src/worker.ts` | Web Worker that counts the prime numbers up to a given `limit` and posts back `{ limit, primes, ms }`. Nothing uses it yet. |
| `src/app.test.ts` | End-to-end test for upload, download, and tamper detection. |
| `uploads/` | Default storage for uploaded files (`<id>.bin` + `<id>.json` metadata). |
| `followers_1.json`, `following.json`, `unfollowers.json` | Instagram data export files and a derived list of accounts that don't follow back. |
| `.tmp-build/` | Leftover bundle output from `bun build`. Safe to delete. |

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

## Tests

```bash
bun test
```

## PR rules

Every pull request runs `.github/workflows/pr-checks.yml`, which has two checks:

- **labels**: the PR needs at least one of `feature`, `enhancement`, `bug` or `documentation`. A PR labelled `wontfix`, `invalid` or `duplicate` fails.
- **issue**: the PR must reference an open GitHub issue in one of these ways:
  - `Closes #123` in the description (this also closes the issue when the PR merges)
  - `#123` in the title
  - a branch named like `feat/123-short-desc`

To make the checks block merging, add `labels` and `issue` as required status checks in the branch protection rule for `main`.

Run the issue check locally:

```bash
GITHUB_REPOSITORY=rades12340/Blob_storage GITHUB_TOKEN=$(gh auth token) \
  PR_TITLE="..." PR_BODY="Closes #1" HEAD_REF=feat/x bun scripts/check-issue.ts
```

## Known issues

- `package.json` lists Express and related middleware (`helmet`, `cors`, `csurf`, `jsonwebtoken`, …), but no code uses them. The server uses `Bun.serve()` directly.
- No script in the repo generates `unfollowers.json`.
- The Instagram JSON files contain personal data and aren't in `.gitignore`. Add them there before pushing this repo anywhere public.
