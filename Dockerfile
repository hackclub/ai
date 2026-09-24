FROM oven/bun:1.4.2 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
# The build imports the server hook, which validates configuration; these
# placeholders satisfy it and never reach the runtime image.
RUN DATABASE_URL=postgres://build@localhost/build \
    OPENROUTER_API_KEY=build \
    TYPESAFE_API_KEY=build \
    bun run build

FROM oven/bun:1.4.2 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.2-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY package.json ./
COPY migrations ./migrations
COPY scripts ./scripts
# scripts/legacy imports from src; one-off imports run inside this container.
COPY src ./src
USER bun
EXPOSE 3000
CMD ["bun", "run", "start"]
