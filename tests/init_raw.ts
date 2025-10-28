// tests/init_raw.ts
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

// ---------- config ----------
const RPC = "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey("6crPEdUww61S2GifdDKHWkFiZXw1EdFu8zR6XBXFjKL3");
const ADMIN_PATH = process.env.ANCHOR_WALLET || "./throwawayadmin.json";
const MINT_PATH  = "./throwawaymint.json";
// Pick your sale_end (seconds since epoch, i64). Example: 2025-10-31 00:00:00Z
//const SALE_END = 1761868800n; // i64
const SALE_END = Math.floor(Date.now() / 1000) + 3600;

// ---------- helpers ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

function loadKeypair(p: string): Keypair {
  const secret = JSON.parse(fs.readFileSync(p, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}
function ixDiscriminator(name: string): Buffer {
  const h = crypto.createHash("sha256").update(`global:${name}`).digest();
  return h.subarray(0, 8);
}
function i64LeBuf(v: bigint | number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(v));
  return b;
}

(async () => {
  const connection = new Connection(RPC, "confirmed");

  // sanity: IDL address should match code address
  const idlPath = path.resolve(__dirname, "../../fair_token/target/idl/fair_token.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  console.log("IDL address:", idl.address);
  console.log("Code  address:", PROGRAM_ID.toBase58());
  if (idl.address !== PROGRAM_ID.toBase58()) {
    console.error("❌ IDL address does NOT match PROGRAM_ID.");
    process.exit(1);
  }

  const admin = loadKeypair(ADMIN_PATH);
  const mint  = loadKeypair(MINT_PATH).publicKey;

  // PDAs per IDL (seeds are consts)
  const [mintAuthorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint_authority")],
    PROGRAM_ID
  );
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    PROGRAM_ID
  );
  const [solVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("sol_vault")],
    PROGRAM_ID
  );
  const [tokenVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_vault")],
    PROGRAM_ID
  );

  // token_vault_account is created via `init` on-chain => must be a fresh signer here
  const tokenVaultAccount = Keypair.generate();

  console.log("Admin:", admin.publicKey.toBase58());
  console.log("Mint :", mint.toBase58());
  console.log("PDA  (mint_authority):", mintAuthorityPda.toBase58());
  console.log("PDA  (config)        :", configPda.toBase58());
  console.log("PDA  (sol_vault)     :", solVaultPda.toBase58());
  console.log("PDA  (token_vault)   :", tokenVaultPda.toBase58());
  console.log("token_vault_account  :", tokenVaultAccount.publicKey.toBase58());
  console.log("sale_end (i64)       :", SALE_END.toString());

  // data = discriminator || i64(sale_end, LE)
  const data = Buffer.concat([
    ixDiscriminator("initialize"),
    i64LeBuf(SALE_END),
  ]);

  const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");

  // Accounts MUST be in the same order as IDL.initialize.accounts[]
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: admin.publicKey,        isSigner: true,  isWritable: true  }, // admin (hard-gated in IDL)
      { pubkey: mint,                   isSigner: false, isWritable: true  }, // mint
      { pubkey: mintAuthorityPda,       isSigner: false, isWritable: false }, // mint_authority (PDA)
      { pubkey: configPda,              isSigner: false, isWritable: true  }, // config (PDA)
      { pubkey: solVaultPda,            isSigner: false, isWritable: true  }, // sol_vault (PDA)
      { pubkey: tokenVaultPda,          isSigner: false, isWritable: true  }, // token_vault (PDA)
      { pubkey: tokenVaultAccount.publicKey, isSigner: true, isWritable: true }, // token_vault_account (new account)
      { pubkey: TOKEN_PROGRAM_ID,       isSigner: false, isWritable: false }, // token_program
      { pubkey: SYSTEM_PROGRAM_ID,      isSigner: false, isWritable: false }, // system_program
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = admin.publicKey;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;

  // Sign with admin + token_vault_account (it's created via init)
  tx.sign(admin, tokenVaultAccount);

  // (optional) simulate for logs
  const sim = await connection.simulateTransaction(tx);
  if (sim.value.err) {
    console.error("Simulation error:", sim.value.err);
    console.error("Logs:\n", (sim.value.logs || []).join("\n"));
    process.exit(1);
  }
  console.log("Simulation ok.");

  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  console.log("initialize tx:", sig);

  // quick post-check (optional): read back mint authority
  try {
    const { getMint } = await import("@solana/spl-token");
    const info = await getMint(connection, mint, "confirmed", TOKEN_PROGRAM_ID);
    console.log("Post-initialize mintAuthority:", info.mintAuthority?.toBase58() || null);
  } catch {
    /* ignore */
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
