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

The file API needs a token from the `auth_service` repo, which should run on port 4000 (see its README).

### Environment

All optional; the defaults fit auth_service running locally.

| Variable | Default | Purpose |
| --- | --- | --- |
| `AUTH_ISSUER` | `http://localhost:4000` | Expected `iss` of access tokens. |
| `AUTH_JWKS_URL` | `$AUTH_ISSUER/.well-known/jwks.json` | Where the public keys are fetched from (cached). |
| `AUTH_AUDIENCE` | `blob_storage` | Expected `aud` of access tokens. |
| `CORS_ORIGIN` | `http://localhost:5173` | Browser frontend allowed to call the API. |

## Project layout

| Path | What it is |
| --- | --- |
| `src/app.ts` | `Bun.serve()` server exported as `startServer({ port, uploadDir, verify, corsOrigin })`. Any unmatched path serves `index.html`. |
| `src/routes.ts` | Route table for the server: `/styles.css` and the file upload/download API (see below). |
| `src/auth.ts` | `createVerifier(...)`: checks the `Authorization: Bearer` JWT against auth_service's public keys. |
| `index.html`, `styles.css` | Static "Six things in a row" demo page (a row of six items plus a stack of avatars). |
| `src/worker.ts` | Web Worker that counts the prime numbers up to a given `limit` and posts back `{ limit, primes, ms }`. Nothing uses it yet. |
| `src/app.test.ts` | End-to-end tests for upload, download, tamper detection, token checks, file ownership and CORS. Signs its own tokens, so auth_service doesn't need to run. |
| `uploads/` | Default storage for uploaded files (`<id>.bin` + `<id>.json` metadata). Created on startup and ignored by git. |
| `context/summarize.md` | Notes summarizing the work done in this repo so far. |
| `.husky/`, `.github/workflows/ci.yml` | Git hooks and CI (see [Checks](#checks)). |

## File API

| Method & path | Description |
| --- | --- |
| `POST /upload` | Multipart form with a `file` field. Stores the file as owned by the token's user. Returns `{ id, ownerId, name, size, sha256 }`. |
| `GET /download/:id` | Returns the file with an `x-file-sha256` header. Responds `404` if the id is unknown or the file belongs to another user, `409` if the stored file no longer matches its recorded hash. |

Both routes need `Authorization: Bearer <access token>` and return `401` without a valid one.

```bash
TOKEN=$(curl -s -X POST localhost:4000/login -H 'content-type: application/json' \
  -d '{"email":"me@example.com","password":"password123"}' | jq -r .accessToken)
curl -H "Authorization: Bearer $TOKEN" -F file=@some.pdf http://localhost:3000/upload
curl -H "Authorization: Bearer $TOKEN" -OJ http://localhost:3000/download/<id>
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

- Uploads are read fully into memory before being written to disk, so very large files use a lot of RAM.
- Files uploaded before authentication was added have no `ownerId` and can no longer be downloaded. Delete them from `uploads/`.
- `.claude/skills/authentication/SKILL.md` is still the empty template; its instructions haven't been written.
