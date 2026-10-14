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

The file API needs a token from the `auth_service` repo, which should run on port 4000 (see its README). Files are stored in AWS S3, so the server won't start until the S3 variables below are set (see [S3 setup](#s3-setup)).

### Environment

Bun loads `.env` automatically, and `.env` is ignored by git.

| Variable | Default | Purpose |
| --- | --- | --- |
| `S3_BUCKET` | **required** | Bucket that holds the files. |
| `S3_REGION` | — | Bucket region, e.g. `eu-central-1`. |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | **required** | Access key of the IAM user below. The `AWS_*` names work too. |
| `S3_ENDPOINT` | AWS | Set only for an S3-compatible server such as MinIO. |
| `MAX_UPLOAD_BYTES` | `26214400` (25 MB) | Larger uploads get `413`. |
| `DOWNLOAD_URL_TTL` | `300` | Seconds a download link stays valid. |
| `AUTH_ISSUER` | `http://localhost:4000` | Expected `iss` of access tokens. |
| `AUTH_JWKS_URL` | `$AUTH_ISSUER/.well-known/jwks.json` | Where the public keys are fetched from (cached). |
| `AUTH_AUDIENCE` | `blob_storage` | Expected `aud` of access tokens. |
| `CORS_ORIGIN` | `http://localhost:5173` | Browser frontend allowed to call the API. |

## Project layout

| Path | What it is |
| --- | --- |
| `src/app.ts` | `Bun.serve()` server exported as `startServer({ port, store, verify, corsOrigin, maxUploadBytes, downloadUrlTtl })`. Any unmatched path serves `index.html`. |
| `src/routes.ts` | Route table for the server: `/styles.css` and the file upload/download API (see below). |
| `src/storage.ts` | `FileStore` interface with an S3 implementation (`createS3Store`, using Bun's built-in `S3Client`) and an in-memory one for tests. `fileKey(owner, id)` builds `files/<owner>/<id>`. |
| `src/auth.ts` | `createVerifier(...)`: checks the `Authorization: Bearer` JWT against auth_service's public keys. |
| `index.html`, `styles.css` | Static "Six things in a row" demo page (a row of six items plus a stack of avatars). |
| `src/worker.ts` | Web Worker that counts the prime numbers up to a given `limit` and posts back `{ limit, primes, ms }`. Nothing uses it yet. |
| `src/app.test.ts` | End-to-end tests for upload, download links, size limit, storage errors, token checks, file ownership and CORS. Uses the in-memory store and signs its own tokens, so neither S3 nor auth_service needs to run. |
| `context/summarize.md` | Notes summarizing the work done in this repo so far. |
| `.husky/`, `.github/workflows/ci.yml` | Git hooks and CI (see [Checks](#checks)). |

## File API

| Method & path | Description |
| --- | --- |
| `POST /upload` | Multipart form with a `file` field. Stores the file in S3 as owned by the token's user. Returns `{ id, ownerId, name, size, type, sha256, createdAt }`. `413` if the file is over `MAX_UPLOAD_BYTES`. |
| `GET /download/:id` | Returns `{ url, expiresAt, name, size, type, sha256 }`, where `url` is a presigned S3 link that downloads the file and expires after `DOWNLOAD_URL_TTL` seconds. `404` if the id is unknown or the file belongs to another user. |

Both routes need `Authorization: Bearer <access token>` and return `401` without a valid one. If S3 can't be reached they return `502`.

Each upload is stored as two objects: `files/<user>/<id>` (the bytes) and `files/<user>/<id>.json` (the record above). The `sha256` is computed when the file is uploaded. Downloads go straight from S3 to the client, so the server doesn't re-check it; a client can compare it with the downloaded bytes.

```bash
TOKEN=$(curl -s -X POST localhost:4000/login -H 'content-type: application/json' \
  -d '{"email":"me@example.com","password":"password123"}' | jq -r .accessToken)
curl -H "Authorization: Bearer $TOKEN" -F file=@some.pdf http://localhost:3000/upload
URL=$(curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/download/<id> | jq -r .url)
curl -OJ "$URL"
```

### S3 setup

One-time setup in the AWS console:

1. **S3 → Create bucket.** Pick a name such as `blob-storage-<you>` and a region. Leave **Block all public access** on: files are only reachable through presigned links.
2. **IAM → Users → Create user** (no console access). Attach an inline policy that allows only what the service does:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Action": ["s3:PutObject", "s3:GetObject"],
       "Resource": "arn:aws:s3:::<bucket>/files/*"
     }]
   }
   ```
3. On that user, **Security credentials → Create access key**, then put the values in `.env`:
   ```bash
   S3_BUCKET=blob-storage-you
   S3_REGION=eu-central-1
   S3_ACCESS_KEY_ID=AKIA...
   S3_SECRET_ACCESS_KEY=...
   ```

To develop without AWS, run a local S3-compatible server. [Adobe S3Mock](https://github.com/adobe/S3Mock) works and accepts any credentials:

```bash
docker run --rm -p 9090:9090 -e COM_ADOBE_TESTING_S3MOCK_STORE_INITIAL_BUCKETS=blobs adobe/s3mock
```

```bash
# .env
S3_ENDPOINT=http://localhost:9090
S3_BUCKET=blobs
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=test
S3_SECRET_ACCESS_KEY=test
```

Remove `S3_ENDPOINT` and use the real values when switching to AWS. S3Mock keeps files only while the container runs, and doesn't check signatures. (MinIO's Docker images are no longer publicly available.)

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

## Releases

Pushing a version tag runs `.github/workflows/release.yml`. It re-runs the CI checks (lint, typecheck, test) on the tagged commit and, only if they pass, publishes a GitHub release:

```bash
git switch main && git pull
git tag v1.1.0
git push origin v1.1.0
```

- Use semver: bump PATCH for fixes, MINOR for features, MAJOR for breaking changes.
- A tag with a suffix, such as `v1.2.0-beta.1`, is published as a pre-release.
- Release notes are generated from merged PRs and grouped by label (see `.github/release.yml`).
- If CI fails, no release is created. Fix the problem, delete the tag (`git push --delete origin v1.1.0 && git tag -d v1.1.0`) and tag again.

## Known issues

- Uploads are read fully into memory before being written to disk, so very large files use a lot of RAM.
- Files in a local `uploads/` folder from before the switch to S3 aren't migrated and are no longer served. The folder can be deleted.
- `.claude/skills/authentication/SKILL.md` is still the empty template; its instructions haven't been written.
