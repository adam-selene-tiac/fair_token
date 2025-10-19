#!/usr/bin/env bash
set -euo pipefail
test -f Anchor.toml || { echo "Run from the repo root (Anchor.toml not found)"; exit 1; }
SOURCE_DATE_EPOCH="$(git log -1 --format=%ct 2>/dev/null || echo 0)"
export SOURCE_DATE_EPOCH
rm -rf target/ && mkdir -p target

echo "== Tool Versions =="
( which solana && solana --version ) || true
( which anchor && anchor --version ) || true
( rustc --version || true )
( cargo --version || true )
node -v || true
npm -v || true
echo "SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}"
echo
echo "== Anchor build =="
anchor build --verifiable
SO="target/deploy/fair_token.so"
test -f "$SO" || { echo "Missing $SO after build"; exit 1; }
SHA="$(shasum -a 256 "$SO" | awk '{print $1}')"
echo "$SHA" > target/fair_token.so.sha256
echo
echo "== Build complete =="
echo "Shared Object : $SO"
echo "SHA256        : $SHA"
