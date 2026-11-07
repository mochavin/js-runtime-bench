# One Dockerfile, one target per runtime: docker build --target deno .
# All three images get the same node_modules (postgres.js), installed once by npm.
FROM node:26.13.0-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:26.13.0-slim AS node
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
USER node
EXPOSE 8000
CMD ["node", "src/node.js"]

FROM denoland/deno:debian-2.9.8 AS deno
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# Cache the module graph at build time so startup does not compile anything.
RUN deno cache src/deno.js
USER deno
EXPOSE 8000
# DENO_SERVE_FLAGS is empty for one process, "--parallel" for one isolate per CPU.
ENV DENO_SERVE_FLAGS=""
CMD ["sh", "-c", "exec deno serve -A --port 8000 $DENO_SERVE_FLAGS src/deno.js"]

FROM oven/bun:1.4.4-slim AS bun
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
USER bun
EXPOSE 8000
CMD ["bun", "src/bun.js"]
