# ---- UI build ----
FROM node:22-slim AS ui
WORKDIR /app
COPY webui/package.json webui/package-lock.json ./webui/
RUN cd webui && npm ci
COPY webui ./webui
RUN cd webui && npm run build

# ---- deps (prod) ----
FROM node:22-slim AS deps
WORKDIR /app
# better-sqlite3 在部分 node 小版本无预编译包，回落 node-gyp 时需要工具链
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime ----
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production \
    DATATIDE_STATIC_DIR=/app/webui/dist \
    DATATIDE_DATA_DIR=/app/data \
    DATATIDE_REPORTS_DIR=/app/reports
COPY package.json ./
COPY src ./src
COPY prompts ./prompts
COPY --from=deps /app/node_modules ./node_modules
COPY --from=ui /app/webui/dist ./webui/dist
RUN mkdir -p /app/data/datasets /app/reports
VOLUME ["/app/data", "/app/reports"]
EXPOSE 8200
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:8200/api/me').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
CMD ["node_modules/.bin/tsx", "src/server.ts"]
