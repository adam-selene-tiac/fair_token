// tests/prepare_mint.ts
// One-shot, idempotent mint preparation for devnet:
// - Create mint (if missing) with decimals=9, admin as mintAuthority, freezeAuthority=null
// - Create metadata (if missing) with provided name/symbol/uri
// - Lock metadata (updateAuthority=None, isMutable=false) if not already locked

import * as fs from "fs";
import * as path from "path";
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createMint,
  getMint,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

// Umi / Metaplex (ESM safe)
import { fileURLToPath } from "url";
import {
  createUmi,
} from "@metaplex-foundation/umi-bundle-defaults";
import {
  keypairIdentity,
  publicKey as umiPk,
  none,
  percentAmount,
} from "@metaplex-foundation/umi";
import { fromWeb3JsKeypair } from "@metaplex-foundation/umi-web3js-adapters";
import {
  mplTokenMetadata,
  fetchMetadata,
  createV1,
  updateV1,
  TokenStandard,
} from "@metaplex-foundation/mpl-token-metadata";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ====== CONFIG (edit as needed) ======
const RPC = process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";
const ADMIN_PATH = process.env.ANCHOR_WALLET || "./throwawayadmin.json";  // EPUo… (current SPL mint authority)
const MINT_PATH  = "./throwawaymint.json";                                // vanity/pre-mined keypair

const DECIMALS = 9;

// Metadata (already hosted)
const NAME   = "TIAC";
const SYMBOL = "TIAC";
const URI    = "https://raw.githubusercontent.com/adam-selene-tiac/tiac-assets/main/metadata/metadata.json";
// =====================================

function loadKeypair(p: string): Keypair {
  const secret = JSON.parse(fs.readFileSync(p, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

async function airdropIfNeeded(connection: Connection, who: PublicKey) {
  const bal = await connection.getBalance(who, "confirmed");
  if (bal < 0.5 * LAMPORTS_PER_SOL) {
    const sig = await connection.requestAirdrop(who, 2 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
    console.log(`Airdropped 2 SOL to ${who.toBase58()}`);
  }
}

(async () => {
  const connection = new Connection(RPC, "confirmed");

  const admin = loadKeypair(ADMIN_PATH);
  const mintKp = loadKeypair(MINT_PATH);
  const mintPk = mintKp.publicKey;

  console.log("RPC:", RPC);
  console.log("Admin:", admin.publicKey.toBase58());
  console.log("Mint keypair pubkey:", mintPk.toBase58());

  await airdropIfNeeded(connection, admin.publicKey);

  // ---- Create mint if it doesn't exist ----
  const exists = await connection.getAccountInfo(mintPk, "confirmed");
  if (!exists) {
    await createMint(
      connection,
      admin,               // payer
      admin.publicKey,     // mintAuthority
      null,                // freezeAuthority = null
      DECIMALS,
      mintKp,
      undefined,
      TOKEN_PROGRAM_ID
    );
    console.log("Mint created:", mintPk.toBase58());
  } else {
    console.log("Mint already exists:", mintPk.toBase58());
  }

  // Inspect mint invariants
  const mintInfo = await getMint(connection, mintPk, "confirmed", TOKEN_PROGRAM_ID);
  console.log("Mint info:", {
    decimals: mintInfo.decimals,
    supply: mintInfo.supply.toString(),
    mintAuthority: mintInfo.mintAuthority?.toBase58?.() || null,
    freezeAuthority: mintInfo.freezeAuthority?.toBase58?.() || null,
  });

  if (mintInfo.decimals !== DECIMALS) {
    throw new Error(`Mint has wrong decimals: ${mintInfo.decimals} (expected ${DECIMALS})`);
  }
  if (mintInfo.freezeAuthority !== null) {
    throw new Error("Mint freezeAuthority must be null.");
  }
  // You *can* allow nonzero supply if you planned it, but your initialize expects zero:
  if (Number(mintInfo.supply) !== 0) {
    throw new Error("Mint supply must be zero for your initialize invariants.");
  }
  if (!mintInfo.mintAuthority || !mintInfo.mintAuthority.equals(admin.publicKey)) {
    throw new Error("Admin must be current SPL mint authority (for initialize Option A).");
  }

  // ---- Umi client (for metadata ops) ----
  const umi = createUmi(RPC).use(mplTokenMetadata());
  umi.use(keypairIdentity(fromWeb3JsKeypair(admin)));

  // Try to fetch metadata
  let md = await fetchMetadata(umi, umiPk(mintPk)).catch(() => null);

  if (!md) {
    console.log("Metadata missing → creating…");
    await createV1(umi, {
      mint: umiPk(mintPk),
      authority: umi.identity,                 // signer
      payer: umi.identity,                     // signer
      updateAuthority: umi.identity.publicKey, // temp; revoke below
      name: NAME,
      symbol: SYMBOL,
      uri: URI,
      sellerFeeBasisPoints: percentAmount(0, 2),
      decimals: DECIMALS,
      tokenStandard: TokenStandard.Fungible,
      isMutable: true, // lock right after
    }).sendAndConfirm(umi);
    console.log("Metadata created.");
    md = await fetchMetadata(umi, umiPk(mintPk));
  } else {
    console.log("Metadata already exists.");
  }

  const uaBefore = md.updateAuthority?.toString?.() ?? null;
  console.log("Current updateAuthority:", uaBefore);

  // ---- Lock metadata: set None and isMutable=false if needed ----
  // We try to lock regardless; if already None, this is a no-op.
  if (uaBefore !== null || md.isMutable) {
    console.log("Locking metadata…");
    await updateV1(umi, {
      mint: umiPk(mintPk),
      authority: umi.identity,   // current updater
      newUpdateAuthority: none(), // burn UA
      isMutable: false,          // lock flag
    }).sendAndConfirm(umi);
    // refetch
    md = await fetchMetadata(umi, umiPk(mintPk));
  } else {
    console.log("Metadata already locked.");
  }

  const uaAfter = md.updateAuthority?.toString?.() ?? null;
  console.log("Post-lock:", { updateAuthority: uaAfter, isMutable: md.isMutable });

  // ---- Summary ----
  console.log("\n✅ Prep complete. Summary:");
  console.log("  Mint:", mintPk.toBase58());
  console.log("  Decimals:", DECIMALS);
  console.log("  SPL mintAuthority (should be admin):", mintInfo.mintAuthority?.toBase58?.() || null);
  console.log("  Metadata updateAuthority (should be null):", uaAfter);
  console.log("  Metadata isMutable (should be false):", md.isMutable);
  console.log("\nNext: run your program initialize to hand SPL mint authority → PDA.");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
