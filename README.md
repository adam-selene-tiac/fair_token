# TIAC — Fair Token (Solana / Anchor)

**Mission:** a flat-price, trustless token with perpetual 1:1 SOL redemption via a program-controlled vault.  
**License:** CC0-1.0 (public domain)

---

## Program ID
`EGxd8LCM8Y1uMyXrWWapEMh9tH2whZaNBYhaV29Mq9fb`

---

## Reproducible build (linux/amd64)

- Solana: **v2.3.11**  
- Anchor: **v0.31.1**

**Official SHA256** of `target/deploy/fair_token.so`:
```
654c9c5ae80159376541395e750a2bf986a9bd1aaaefb03842e78baf3a8f404e
```

See **`VERIFY.md`** for the step-by-step reproducible build and verification.

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
