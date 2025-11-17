FROM oven/bun:1 AS base
WORKDIR /app

FROM base AS deps
COPY package.json ./
RUN bun install --frozen-lockfile --production

FROM base AS build
COPY package.json ./
RUN bun install --frozen-lockfile
COPY . .

FROM base AS runtime
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=build /app/drizzle ./drizzle
RUN apk add --no-cache ca-certificates

USER bun
EXPOSE 3000
CMD ["bun", "run", "start"]
