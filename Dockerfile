# scrum4me-mcp — HTTP server image, run via tsx (consumes @shared TS at runtime).
#
# @shared (vendor/scrum4me-shared) ships TS source only, so there is no dist build.
# - deps stage generates the Prisma client: the postinstall hook runs
#   scripts/gen-schema.sh (which reads vendor/scrum4me-shared), so scripts/ AND
#   vendor/ must be present before `npm ci`.
# - build stage runs `npm run typecheck` (tsc --noEmit) as a gate; it needs vendor/
#   so tsc can resolve the @shared re-exports. No emit.
# - runtime runs `tsx src/http.ts` with src/, vendor/, tsconfig.json and the
#   generated client present; cwd /app has tsconfig.json so tsx resolves @shared.
# We keep the full node_modules (no --omit=dev) because tsx is a devDependency.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
COPY scripts ./scripts
COPY vendor ./vendor
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json tsconfig.json ./
COPY prisma ./prisma
COPY src ./src
COPY vendor ./vendor
RUN npm run typecheck

FROM node:22-alpine AS runtime
RUN apk add --no-cache tini
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8000
ENV HOST=0.0.0.0
# node_modules from deps already contains the generated Prisma client + tsx.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/vendor ./vendor
COPY package*.json tsconfig.json ./
COPY prisma ./prisma
EXPOSE 8000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node_modules/.bin/tsx", "src/http.ts"]
