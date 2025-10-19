# ARCHITECTURE — TIAC Fair Token (Solana / Anchor)

**Program ID:** `EGxd8LCM8Y1uMyXrWWapEMh9tH2whZaNBYhaV29Mq9fb`  
**Toolchain:** Solana v2.3.11, Anchor v0.31.1 (verifiable Docker build)  
**Goal:** Flat-price token minting during the initial sale and perpetual 1:1 SOL redemption at the initial sale price.

---

## 1) High‑level design

- **Singleton** program with a one‑time `initialize` step; parameters thereafter are immutable.
- **Pricing invariant:** **1 lamport == 1 base unit** of the token (with `DECIMALS = 9`), i.e. 10^9 base units per human‑readable token. There is no runtime configurable price.
- Users **buy** during the initial sale by sending SOL. Pre‑finalization the program **mints** to the buyer.
- Users **redeem** at any time for SOL 1:1 vs base units:
  - Pre‑finalization: the user **burns** their tokens from their ATA (authority = user signer), program sends SOL from the SOL vault.
  - Post‑finalization: the user **transfers** tokens to the token vault account (authority = user signer), program sends SOL from the SOL vault.
- **Finalization:** when the sale ends, the program may **mint a shortfall** to the token vault account to bring the circulating supply up to `MIN_SUPPLY_TOKENS * 10^9` if needed, then **revokes mint authority** permanently and marks the sale as finalized.

---

## 2) Accounts & PDAs

### 2.1 Program‑derived addresses (PDAs)
- **Config PDA** — seeds: `["config"]`  
  Tracks mint, sale window, finalization flag, counters, and bumps.
- **Mint Authority PDA** — seeds: `["mint_authority"]`  
  Temporary SPL mint authority until finalization; revoked at finalization.
- **SOL Vault PDA** — seeds: `["sol_vault"]`  
  A **system‑owned** PDA (owner = System Program, data_len = 0) that holds the SOL backing for redemptions.
- **Token Vault PDA** — seeds: `["token_vault"]`  
  A program‑owned PDA that is the **authority/owner** for the token vault SPL account used after finalization.
- **Token Vault SPL Account** — SPL TokenAccount holding program‑controlled inventory used for **post‑finalization** buys/redemptions.

### 2.2 Other runtime accounts
- **User** (signer)  
- **User ATA** (token account)  
- **Token Mint** (SPL mint; `DECIMALS = 9`, freeze authority = None)

---

## 3) Instruction set (code‑accurate)

- **`initialize(ctx, sale_end: i64)`**  
  - Gated to the **ADMIN** address.  
  - Validates that `sale_end` lies within **[45, 90] days** from the current slot time.  
  - Sets up PDAs and records config.

- **`buy_fair_token(ctx, lamports_sent: u64)`**  
  - Pre‑finalization: transfers SOL to the SOL vault PDA and **mints** the corresponding base units to the buyer’s ATA.  
  - Post‑finalization: transfers SOL to the SOL vault PDA and **transfers** tokens **from** the token vault SPL account to the buyer’s ATA.

- **`redeem_fair_token(ctx, amount_to_redeem: u64)`**  
  - Pre‑finalization: **burns** `amount_to_redeem` from the **user’s ATA** (authority = user signer), then transfers the same amount of SOL from the SOL vault PDA to the user.  
  - Post‑finalization: **transfers** `amount_to_redeem` tokens from the user’s ATA **to the token vault SPL account**, then transfers the same amount of SOL from the SOL vault PDA to the user.

**Constants (from code):**
- `DECIMALS: u8 = 9`  
- `MIN_SUPPLY_TOKENS: u64 = 100_000` (minimum target supply — enforced at finalization via top‑up mint if needed)  
- `MIN_WINDOW: i64 = 45` days, `MAX_WINDOW: i64 = 90` days

---

## 4) Security properties & invariants

- **Pricing invariant:** one lamport always equals one base unit; no rounding or price parameters exist at runtime.  
- **SOL safety:** SOL is only ever held in the **SOL Vault PDA** (system‑owned lamports account); all payouts originate from this PDA under PDA signer seeds.  
- **Mint control:** pre‑finalization, the program mints via **Mint Authority PDA**; at finalization the mint authority is set to **None** permanently.  
- **Post‑finalization supply discipline:** no new tokens can be minted; buys are served from **Token Vault SPL Account** only.  
- **No privileged profit path:** there are no developer‑only mint or withdraw paths; redemptions are symmetric and public.

---

## 5) Admin gating & upgrades

- `initialize` is **address‑gated** to a fixed **ADMIN** public key baked into the program.  
- After audit and deployment of the audited binary, you should **revoke program upgrade authority** (set to `None`). See `README.md` for the exact CLI steps.

---

## 6) Events & errors (overview)

The program emits events for buys, redeems, and finalization, and returns explicit errors for configuration violations and insufficient balances. Refer to source for exact enum/field names to map on‑chain logs unambiguously.

---

## 7) Verification

- Build and extract the `.so` from the pinned Docker image as described in `VERIFY.md`.  
- Compare the resulting SHA256 against the **Official SHA256** published in `README.md`/`VERIFY.md`.
