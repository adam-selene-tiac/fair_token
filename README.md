# TIAC — Fair Token (Solana / Anchor)

[![Verify Build Reproducibility](https://github.com/adam-selene-tiac/fair_token/actions/workflows/verify.yml/badge.svg)](https://github.com/adam-selene-tiac/fair_token/actions/workflows/verify.yml)

**Mission:** a flat-price, trustless token with perpetual 1:1 SOL redemption via a program-controlled vault.
**License:** CC0-1.0 (public domain)

---

## Program ID
`EGxd8LCM8Y1uMyXrWWapEMh9tH2whZaNBYhaV29Mq9fb`

---

## Reproducible build (linux/amd64)

- Solana: **v2.3.11**
- Anchor: **v0.31.1**

**Verifiable build SHA256** of `target/verifiable/fair_token.so`:
```
ecfa8038958c9fbf31ae316329e4eca21f3b8f36aee34e26744d16cfd5cffc48
```

**Audited source SHA256** of `programs/fair_token/src/lib.rs` (verified by Cyberscope):
```
a628e12427066634e24db6e8f4de4054138efd4f740f2c386218c88a21c156b9
```

Build reproducibility is verified automatically via GitHub Actions on every commit.
See the badge above for current status, or run `anchor build --verifiable` yourself.

---

## Security & trust model (summary)

- **No developer-only profit avenues.**  
- **Flat price during the initial sale** (prevents MEV/front-running advantages).
- **All SOL proceeds remain in a program-controlled vault** (accessible only via redemptions).
- **Perpetual 1:1 redemption** at the initial sale price.
- **Singleton design** with PDAs for mint authority and vault accounts.

See **`ARCHITECTURE.md`** for details.

---

## Post‑audit hardening checklist

After the audit, when you deploy the audited build:

```bash
# 1) Permanently revoke program upgrade authority (cannot be undone)
solana program set-upgrade-authority EGxd8LCM8Y1uMyXrWWapEMh9tH2whZaNBYhaV29Mq9fb --new-upgrade-authority none

# 2) Verify upgrade authority is None
solana program show EGxd8LCM8Y1uMyXrWWapEMh9tH2whZaNBYhaV29Mq9fb
```

(If you deploy to devnet first, repeat the check on mainnet once you deploy the audited binary.)

---

## License

This project is dedicated to the public domain under **CC0-1.0**.  
See `LICENSE` for details.
