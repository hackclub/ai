# Build stage
FROM rust:1.75-slim-bookworm AS builder

WORKDIR /usr/src/app

# Install pkg-config and openssl for potential dependencies
RUN apt-get update && \
    apt-get install -y pkg-config libssl-dev && \
    rm -rf /var/lib/apt/lists/*

# Copy over your manifests
COPY Cargo.toml Cargo.lock ./

# Copy your source code
COPY src ./src
COPY templates ./templates

# Build the actual application
RUN cargo build --release

# Final stage
FROM debian:bookworm-slim

# Install SSL certificates for HTTPS requests
RUN apt-get update && \
    apt-get install -y ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /usr/src/app/target/release/ai .
COPY --from=builder /usr/src/app/templates ./templates

# Set the startup command
ENV KEY=""
ENV GEMINI_KEY=""
ENV GROQ_KEY=""
EXPOSE 8080

CMD ["./ai"]

