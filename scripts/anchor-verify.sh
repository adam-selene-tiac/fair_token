cat > scripts/anchor_verify.sh <<'SH'
#!/usr/bin/env bash
set -euo pipefail
SOLANA_VERSION=2.3.11
SOLANA_ARCH=x86_64-unknown-linux-gnu

# Install Agave toolchain into /opt/solana and add to PATH
mkdir -p /opt/solana
curl -fsSL -o /tmp/solana.tar.bz2 "https://github.com/anza-xyz/agave/releases/download/v${SOLANA_VERSION}/solana-release-${SOLANA_ARCH}.tar.bz2"
tar -xjf /tmp/solana.tar.bz2 -C /opt/solana --strip-components=1
export PATH="/opt/solana/bin:$PATH"

# Use a modern Rust toolchain
rustup toolchain install 1.82.0 >/dev/null
rustup default 1.82.0 >/dev/null

anchor --version
solana --version

anchor build --skip-lint
shasum -a 256 target/deploy/fair_token.so | awk '{print $1}' | tee target/deploy/fair_token.so.sha256
SH
chmod +x scripts/anchor_verify.sh
