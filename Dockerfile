ARG BUN_VERSION=1.3.4
ARG RUST_VERSION=1.97.1

FROM oven/bun:${BUN_VERSION} AS bun

FROM rust:${RUST_VERSION}-bookworm AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app

COPY package.json bun.lock ./
COPY patches/ ./patches/
RUN bun install --frozen-lockfile

COPY Cargo.toml Cargo.lock ./
COPY crates/ ./crates/
RUN bun run --bun build -- -- --locked

FROM debian:bookworm-slim AS base
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libgcc-s1 libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 bun
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app

FROM base AS dependencies
COPY package.json bun.lock ./
COPY patches/ ./patches/
RUN bun install --frozen-lockfile --production

FROM base AS runtime
ENV NODE_ENV=production
COPY package.json ./
COPY --from=dependencies /app/node_modules ./node_modules/
COPY ts/ ./ts/
COPY --from=build /app/ts/native ./ts/native/
COPY slack/manifest.json ./slack/manifest.json
USER bun
CMD ["bun", "ts/slackbot.ts"]
