FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run typecheck && SENTRY_CONTAINER_BUILD=1 npm run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    SENTRY_DATA_DIR=/app/data \
    SENTRY_GATEWAY_HOST=0.0.0.0
# Vinext 的生产 CLI 仍使用其运行时依赖，保留锁文件安装出的依赖树。
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/scripts/dev.mjs ./scripts/dev.mjs
COPY --from=build --chown=node:node /app/package.json ./package.json
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000 3002
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "Promise.all(['http://127.0.0.1:3000/api/health','http://127.0.0.1:3002/login'].map(u=>fetch(u).then(r=>{if(!r.ok)throw Error(r.status)}))).catch(()=>process.exit(1))"
CMD ["node", "scripts/dev.mjs", "--production"]
