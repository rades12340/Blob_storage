FROM oven/bun:1.3.11-alpine

WORKDIR /app

# --ignore-scripts skips the "prepare" script (husky), a dev-only git hook setup.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

COPY tsconfig.json index.html styles.css ./
COPY src ./src

USER bun
EXPOSE 3000
CMD ["bun", "src/app.ts"]
