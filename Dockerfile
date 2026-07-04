# ---------- build stage ----------
FROM node:20-bookworm AS builder
WORKDIR /app

# Toolchain for native modules (better-sqlite3, node-pty).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# Server deps (compiled here against the same Node/glibc the runtime uses).
COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci --omit=dev

# Client deps + build.
COPY client/package.json client/package-lock.json client/
RUN cd client && npm ci
COPY client/ client/
RUN cd client && npm run build

COPY server/ server/

# ---------- runtime stage ----------
FROM node:20-bookworm-slim AS runtime
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends tmux ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=6880 \
    PUBLIC_DIR=/app/client/dist \
    DB_PATH=/app/server/data/dashboard.db

COPY --from=builder /app/server /app/server
COPY --from=builder /app/client/dist /app/client/dist

EXPOSE 6880
WORKDIR /app/server
CMD ["node", "src/server.js"]
