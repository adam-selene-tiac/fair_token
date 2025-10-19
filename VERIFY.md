# Verify the TIAC build (linux/amd64)

## Build and extract
```bash
docker build --platform=linux/amd64 -t fair-token-audit:2.3.11-0.31.1 -f Dockerfile .

CID=$(docker create fair-token-audit:2.3.11-0.31.1 /bin/true)
rm -rf target/deploy && mkdir -p target/deploy
docker cp "$CID":/work/target/deploy/. ./target/deploy/
docker cp "$CID":/work/sha256.txt ./sha256.txt
docker rm "$CID"

# Show both the file hash and the recorded hash
shasum -a 256 target/deploy/fair_token.so
cat sha256.txt
```

## Official SHA256

8adced354f90f48f880c9bfe8e5715293db06371334c9053469655d0b06cd663
