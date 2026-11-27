# syntax=docker/dockerfile:1.6

# ---------- build ------------------------------------------------------------
FROM rust:1.90-bookworm AS builder

WORKDIR /app

# Dependencies are recompiled only when the manifest or lockfile changes.
COPY Cargo.toml Cargo.lock ./
COPY .sqlx ./.sqlx
COPY migrations ./migrations
COPY src ./src

# Compile-time checked SQL uses the committed `.sqlx` metadata, so the image
# does not need a live database during the build.
ENV SQLX_OFFLINE=true
RUN cargo build --release --locked

# ---------- runtime ----------------------------------------------------------
FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 --shell /usr/sbin/nologin ciphertalk

WORKDIR /app
RUN mkdir -p /app/uploads && chown ciphertalk:ciphertalk /app/uploads

COPY --from=builder /app/target/release/ciphertalk /usr/local/bin/ciphertalk
COPY web ./web
COPY migrations ./migrations

ENV HOST=0.0.0.0 \
    PORT=8080 \
    STATIC_DIR=/app/web \
    UPLOAD_DIR=/app/uploads \
    RUN_MIGRATIONS=true \
    RUST_LOG=ciphertalk=info,tower_http=info,sqlx=warn

USER ciphertalk
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8080/health/ready || exit 1

CMD ["ciphertalk"]
