# qaa product container for Sigma Link (plaud-agent-platform allocator starts one per tenant).
# Build from the repo root:  docker build -f ops/Dockerfile -t qaa:$(git describe --tags)-plaud .
# Upstream is untouched: this file, the entrypoint and the ignore file live under ops/ only.
ARG NODE_VERSION=22.22.2

# ── build: web UI needs the dev toolchain (vite) ─────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /src
ENV QWEN_AUDIO_AGENT_PREPARE=1
COPY . .
RUN npm ci --no-audit --no-fund && npm run build

# ── runtime ─────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    QWEN_AUDIO_AGENT_PREPARE=1 \
    HOST=0.0.0.0 \
    PORT=3000 \
    HOME=/data \
    QWAUDIO_CONFIG_DIR=/data/qwaudio
# LICENSE / NOTICE / THIRD_PARTY_NOTICES.md ship with the source tree (Apache-2.0 §4).
COPY . .
COPY --from=build /src/web/dist ./web/dist
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force \
    && groupadd -g 10001 qaa && useradd -u 10001 -g 10001 -M -s /usr/sbin/nologin qaa \
    && mkdir -p /data && chown 10001:10001 /data \
    && chmod 755 ops/docker-entrypoint.sh
USER 10001:10001
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["ops/docker-entrypoint.sh"]
CMD ["node", "server/src/index.mjs"]
