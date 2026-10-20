# Cargo.lock is format v4 (Cargo 1.78+); build with current stable like CI does.
# bookworm matches the runtime image below (glibc, libssl3).
FROM rust:1-bookworm AS builder
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY migrations ./migrations
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y libssl3 ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/target/release/groutpro-backend .
COPY migrations ./migrations
ENV RUST_LOG=info
EXPOSE 3100
CMD ["./groutpro-backend"]
