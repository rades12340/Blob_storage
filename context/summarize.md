# js_practice — summary of work so far

_Written 2026-10-12. Built from the files in the repo and their modification dates. The repo has no git history, so the order of work is approximate._

## What the project is

A Bun + TypeScript sandbox with a few small, unrelated experiments, not one finished app.

## What's been built

### 1. File upload/download server (`src/app.ts`, last changed Oct 11)
- `startServer({ port, uploadDir })` wraps `Bun.serve()`.
- `POST /upload` takes a multipart `file` field, saves `<id>.bin` and `<id>.json` (id, name, size, sha256) into `uploads/`, and returns the metadata.
- `GET /download/:id` checks the id format, re-hashes the stored file, and returns `409` if the hash no longer matches (tamper detection), `404` if the id is unknown. Otherwise it sends the file with an `x-file-sha256` header.
- Every other route serves `index.html`. `/styles.css` is served directly.
- Run with `bun run dev` (`bun --watch src/app.ts`) on port 3000.

### 2. End-to-end test (`src/app.test.ts`, Jul 19)
- Uploads a ~64 KB generated file to a temp directory, checks the returned name, size and SHA-256, downloads it and compares the bytes, then corrupts the stored file and expects a `409`.
- Run with `bun test`.

### 3. Prime-counting Web Worker (`src/worker.ts`, Jul 9)
- Takes `{ limit }`, counts the primes up to it, and posts back `{ limit, primes, ms }`.
- Nothing calls it yet. There's a matching local skill at `.agents/skills/worker-treads-in-bun/`.

### 4. "Six things in a row" demo page (`index.html`, `styles.css`, Sep 9)
- A static page with a row of six labels (Explore, Plan, Create, Build, Share, Repeat) and a stack of avatar initials. It uses the DM Sans and Space Grotesk fonts.

### 5. README (`README.md`, Oct 11)
- Covers setup, project layout, the file API with curl examples, worker usage, tests, and known issues.

### 6. Tooling
- `CLAUDE.md`: use Bun everywhere (`bun test`, `Bun.serve`, `Bun.file`, and so on).
- `.claude/skills/authentication/`: a local skill for generating and testing JWT auth. No auth code exists in `src/` yet.
- `.skills/project.json`: pinned skills (codefix, commitpush, commitpushpr, manageskill, scancommitpr, scancommitpush).

## Loose ends / known issues
- `package.json` still lists Express, helmet, cors, csurf, jsonwebtoken, express-rate-limit and express-validator, but no code uses them. They can be removed, unless the JWT auth work is meant to use `jsonwebtoken`.
- `index.html` puts `<li>` elements directly inside a `<div class="avatars">`, which is invalid HTML. The container should be a `<ul>`.
- The README mentions Instagram export files (`followers_1.json`, `following.json`, `unfollowers.json`), but they're no longer in the repo. That README row and its known-issue note are out of date.
- Both `package-lock.json` and `bun.lock` exist. Only `bun.lock` is needed.
- `.tmp-build/` is leftover `bun build` output and can be deleted.
- `GEMINI.md` is empty.
- The repo isn't under git yet.

## Possible next steps
- Use the prime worker from the server or the page, for example a `/primes?limit=` route or a button on the page.
- Build the JWT auth with the `authentication` skill.
- Clean up the unused dependencies and the stale README entries.
