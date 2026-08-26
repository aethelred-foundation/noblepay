FROM node:24.18.0-bookworm-slim AS build
WORKDIR /app/backend
ENV NODE_ENV=development
# Prisma resolves its query engine by detecting the libssl version at run time.
# The slim image ships without the openssl package, so detection fails, Prisma
# falls back to openssl-1.1.x, and the engine it then wants is not the one
# baked into the image - so it tries to download one on first use. Installing
# openssl here is what makes `prisma generate` below fetch the correct engine
# at BUILD time instead.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --ignore-scripts
COPY backend/prisma ./prisma
RUN npx prisma generate
COPY backend/tsconfig.json ./tsconfig.json
COPY backend/src ./src
RUN npm run build

FROM node:24.18.0-bookworm-slim AS production-dependencies
WORKDIR /app/backend
ENV NODE_ENV=production
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

FROM build AS migration
ENV NODE_ENV=production
# The build stage runs as root, so everything it created is root-owned. Handing
# the container to `node` without transferring ownership left prisma unable to
# write its engine directory:
#
#   Error: Can't write to /app/backend/node_modules/@prisma/engines
#
# Migrations still run unprivileged. Ownership is transferred only for the
# directories prisma writes: a recursive chown of node_modules would copy all
# 281 MB into a new layer for the sake of an ownership bit.
RUN chown -R node:node \
      /app/backend/node_modules/@prisma \
      /app/backend/node_modules/.prisma \
      /app/backend/prisma
USER node

FROM gcr.io/distroless/nodejs24-debian13@sha256:af85d11ce7ef10172855a6e3649e3e8125b1b9e3ca41849ec2918036f05cb212 AS runtime
WORKDIR /app/backend
ENV NODE_ENV=production PORT=4008
COPY --from=build --chown=65532:65532 /app/backend/package.json /app/backend/package-lock.json ./
COPY --from=production-dependencies --chown=65532:65532 /app/backend/node_modules ./node_modules
COPY --from=build --chown=65532:65532 /app/backend/node_modules/.prisma ./node_modules/.prisma
COPY --from=build --chown=65532:65532 /app/backend/dist ./dist
COPY --from=build --chown=65532:65532 /app/backend/prisma ./prisma
USER 65532:65532
EXPOSE 4008
HEALTHCHECK --interval=20s --timeout=5s --start-period=20s --retries=5 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:4008/readyz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["dist/index.js"]
