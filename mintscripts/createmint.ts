// tests/createmint.ts
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createMint } from "@solana/spl-token";
import * as mpl from "@metaplex-foundation/mpl-token-metadata"; // CJS-safe namespace import
import * as fs from "fs";

// ---- Config ----
const ADMIN_PATH = "./throwawayadmin.json";
const MINT_PATH  = "./throwawaymint.json";
const RPC        = process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";

// Your displayed metadata (JSON already hosted)
const NAME     = "TrumpIsA****";
const SYMBOL   = "TIAC"; // keep it short; many UIs expect <= 10 chars
const URI      = "https://raw.githubusercontent.com/adam-selene-tiac/tiac-assets/main/metadata/metadata.json"; // <= ~200 chars
const DECIMALS = 9; // 1 lamport == 1 base unit

function loadKeypair(file: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main() {
  const connection = new Connection(RPC, "confirmed");

  // Load signers
  const admin = loadKeypair(ADMIN_PATH);
  const mintKeypair = loadKeypair(MINT_PATH);

  console.log("RPC:", RPC);
  console.log("Admin:", admin.publicKey.toBase58());
  console.log("Mint keypair pubkey:", mintKeypair.publicKey.toBase58());

  // --- 1) Create Mint (freezeAuthority = null) ---
  const mintPubkey = await createMint(
    connection,
    admin,                 // payer
    admin.publicKey,       // initial mint authority (EOA; hand to PDA later)
    null,                  // freezeAuthority = null (recommended)
    DECIMALS,
    mintKeypair,           // use your vanity keypair to fix the address
    undefined,             // confirm opts
    TOKEN_PROGRAM_ID
  );
  console.log("Mint created:", mintPubkey.toBase58());

  // --- 2) Derive Metadata PDA ---
  const tmProg = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
  const [metadataPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), tmProg.toBuffer(), mintPubkey.toBuffer()],
    tmProg
  );
  console.log("Metadata PDA:", metadataPda.toBase58());

  // If metadata already exists, don’t try to recreate/lock it
  const existingMd = await connection.getAccountInfo(metadataPda);
  if (existingMd) {
    console.log("Metadata already exists on-chain; aborting create/lock step.");
    console.log("Summary:");
    console.log("  Mint:", mintPubkey.toBase58());
    console.log("  Metadata PDA:", metadataPda.toBase58());
    console.log("  Decimals:", DECIMALS);
    return;
  }

  // --- 3) Build Create + Lock Metadata instructions ---
  const dataV2 /* : mpl.DataV2 */ = {
    name: NAME,
    symbol: SYMBOL,
    uri: URI,
    sellerFeeBasisPoints: 0, // fungible
    creators: null,
    collection: null,
    uses: null,
  };

  const createIx = mpl.createCreateMetadataAccountV3Instruction(
    {
      metadata: metadataPda,
      mint: mintPubkey,
      mintAuthority: admin.publicKey,
      payer: admin.publicKey,
      updateAuthority: admin.publicKey, // temp; we burn it next
    },
    {
      createMetadataAccountArgsV3: {
        data: dataV2,
        isMutable: true, // will lock below
        collectionDetails: null,
      },
    }
  );

  const updateIx = mpl.createUpdateMetadataAccountV2Instruction(
    {
      metadata: metadataPda,
      updateAuthority: admin.publicKey,
    },
    {
      updateMetadataAccountArgsV2: {
        data: null,            // no change
        updateAuthority: null, // burn update authority (None)
        primarySaleHappened: null,
        isMutable: false,      // make immutable
      },
    }
  );

  // --- 4) Send transaction (create + lock) ---
  const tx = new Transaction().add(createIx, updateIx);
  const sig = await sendAndConfirmTransaction(connection, tx, [admin]);
  console.log("Metadata created & locked. Tx:", sig);

  // --- 5) Summary ---
  console.log("Summary:");
  console.log("  Mint:", mintPubkey.toBase58());
  console.log("  Metadata PDA:", metadataPda.toBase58());
  console.log("  Decimals:", DECIMALS);
  console.log("  Locked: isMutable=false, updateAuthority=None");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
