# syntax=docker/dockerfile:1.6

# Always build for linux/amd64 (repro with auditors & CI)
FROM --platform=linux/amd64 rust:1.82-bookworm AS build

ARG SOLANA_VERSION=2.3.11
ARG ANCHOR_VERSION=0.31.1
ENV PATH=/usr/local/cargo/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Minimal deps; include bzip2 for tarball; keep image stable & small
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      pkg-config libssl-dev libudev-dev git ca-certificates curl jq xz-utils bzip2 build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install Solana (Agave) from GitHub tarball (no TLS to release.solana.com)
# We are *forcing* amd64, so use the x86_64 tarball explicitly.
ENV SOLANA_ARCH=x86_64-unknown-linux-gnu
RUN set -eux; \
    curl -fL --retry 5 --retry-delay 2 -o /tmp/solana.tar.bz2 \
      "https://github.com/anza-xyz/agave/releases/download/v${SOLANA_VERSION}/solana-release-${SOLANA_ARCH}.tar.bz2"; \
    mkdir -p /opt/solana; \
    tar -xjf /tmp/solana.tar.bz2 -C /opt/solana --strip-components=1; \
    ln -s /opt/solana/bin/* /usr/local/bin/; \
    solana --version

# Install Anchor CLI (pinned)
# You can switch to crates.io if you prefer:  cargo install anchor-cli --version ${ANCHOR_VERSION} --locked
RUN cargo install --git https://github.com/coral-xyz/anchor --tag v${ANCHOR_VERSION} anchor-cli --locked \
 && anchor --version \
 && rustc --version && cargo --version

# Build your program
WORKDIR /work

# Copy manifests first to leverage build cache
COPY Cargo.toml Anchor.toml rust-toolchain.toml ./
COPY programs/fair_token/Cargo.toml programs/fair_token/Cargo.toml

# Warm dependency cache (no sources yet)
RUN mkdir -p programs/fair_token/src \
 && echo "pub fn main() {}" > programs/fair_token/src/lib.rs \
 && cargo build-sbf --manifest-path programs/fair_token/Cargo.toml --release || true

# Real sources + final build
COPY programs/fair_token/src programs/fair_token/src

RUN cargo build-sbf --manifest-path programs/fair_token/Cargo.toml \
 && ls -l target/deploy \
 && shasum -a 256 target/deploy/fair_token.so > /work/sha256.txt \
 && cat /work/sha256.txt
