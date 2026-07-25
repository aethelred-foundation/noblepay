FROM node:24.18.0-bookworm-slim AS build
WORKDIR /app/backend
ENV NODE_ENV=development
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
