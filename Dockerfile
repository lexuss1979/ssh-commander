# --- Build web ---
FROM node:22-alpine AS web-builder
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# --- Build server ---
FROM node:22-alpine AS server-builder
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build

# --- Prod deps (runtime gets no devDependencies like tsx/typescript/vitest) ---
FROM node:22-alpine AS server-deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# --- Dev (deps only; source bind-mounted at runtime for hot reload) ---
FROM node:22-alpine AS dev
WORKDIR /app
COPY server/package.json server/package-lock.json ./server/
RUN cd /app/server && npm ci
COPY web/package.json web/package-lock.json ./web/
RUN cd /app/web && npm ci

# --- Runtime ---
FROM node:22-alpine
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/lexuss1979/ssh-commander" \
      org.opencontainers.image.revision=$REVISION \
      org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=web-builder /app/web/dist ./web/dist
COPY --from=server-builder /app/server/dist ./dist
COPY --from=server-deps /app/server/node_modules ./node_modules
# APP_HOST=0.0.0.0 нужен только внутри контейнера: наружу порт публикуется
# как 127.0.0.1:8080 (docker-compose.yml). Дефолт приложения — 127.0.0.1.
ENV DATA_DIR=/data KEYS_DIR=/keys WEB_DIST=/app/web/dist APP_HOST=0.0.0.0
EXPOSE 8080
CMD ["node", "dist/index.js"]
