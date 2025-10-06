FROM rust:1.89.0 AS builder
WORKDIR /app
COPY . .
RUN cargo build --release

FROM debian:trixie-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/hackclub-ai /usr/local/bin/hackclub-ai
ENV PORT=8080
EXPOSE 8080
CMD ["/usr/local/bin/hackclub-ai"]
