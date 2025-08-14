FROM rust:1.89.0 AS builder
WORKDIR /app
COPY . .
RUN cargo build --release

FROM gcr.io/distroless/cc
COPY --from=builder /app/target/release/hackclub-ai /usr/local/bin/hackclub-ai
ENV PORT=8080
EXPOSE 8080
CMD ["/usr/local/bin/hackclub-ai"]
