FROM node:22-slim

# better-sqlite3 ships prebuilt binaries for linux x64/arm64 glibc, but keep
# build tools available as a fallback for other targets.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY src ./src
COPY prompts ./prompts

# SQLite lives on a volume so state survives redeploys.
ENV DB_PATH=/app/data/launch.db
VOLUME ["/app/data"]

CMD ["node", "src/index.js"]
