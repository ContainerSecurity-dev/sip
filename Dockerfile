# syntax=docker/dockerfile:1

FROM dhi.io/node:22-debian12-dev AS build
ARG BUILDKIT_SBOM_SCAN_STAGE=true
WORKDIR /app

COPY package.json package-lock.json .npmrc ./
COPY scripts/validate-lockfile-age.mjs ./scripts/validate-lockfile-age.mjs
RUN npm install --global npm@11.10.0 --ignore-scripts \
    && node scripts/validate-lockfile-age.mjs \
    && npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
    && npm prune --omit=dev --ignore-scripts

FROM dhi.io/node:22-debian12 AS runtime
ARG BUILDKIT_SBOM_SCAN_STAGE=true
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
