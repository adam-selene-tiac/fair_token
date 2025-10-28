// tests/fair_token.ts
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import * as anchor from "@coral-xyz/anchor";
import { BN } from "bn.js";
import {
  Connection, PublicKey, SystemProgram, Keypair, clusterApiUrl,
  Transaction, sendAndConfirmTransaction, TransactionInstruction, AccountMeta,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getMint, getOrCreateAssociatedTokenAccount, getAccount } from "@solana/spl-token";

// === your deployed program id ===
const PROGRAM_ID = new PublicKey("6crPEdUww61S2GifdDKHWkFiZXw1EdFu8zR6XBXFjKL3");
// =================================

const EXPECTED_DECIMALS = 9;
const LAMPORTS_PER_TOKEN = 1_000_000_000;

const norm   = (s: string) => s.replace(/[_-]/g, "").toLowerCase();
const toCamel = (s: string) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
function argNum(name: string, def: number) { const i = process.argv.indexOf(name); return (i>=0 && process.argv[i+1]) ? parseFloat(process.argv[i+1]) : def; }

const PDAS = (pid: PublicKey) => ({
  config:        PublicKey.findProgramAddressSync([Buffer.from("config")],         pid)[0],
  mintAuthority: PublicKey.findProgramAddressSync([Buffer.from("mint_authority")], pid)[0],
  solVault:      PublicKey.findProgramAddressSync([Buffer.from("sol_vault")],      pid)[0],
  tokenVault:    PublicKey.findProgramAddressSync([Buffer.from("token_vault")],    pid)[0],
});

// ---- raw-instruction helpers ----
function sighash(ixName: string) {
  const pre = `global:${ixName}`;
  return crypto.createHash("sha256").update(pre).digest().subarray(0, 8);
}
function u64le(n: BN | number | bigint) {
  const v = typeof n === "number" ? BigInt(n) : (BN.isBN(n) ? BigInt(n.toString()) : BigInt(n));
  const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b;
}
type IdlInstr = { name: string; accounts: Array<{ name: string; isMut?: boolean; isSigner?: boolean }>; args: Array<{ name: string; type: any }> };

function buildIx(
  programId: PublicKey,
  idlInstr: IdlInstr,
  argBufs: Buffer[],
  byName: Record<string, { pubkey: PublicKey; isWritable?: boolean; isSigner?: boolean }>
) {
  const data = Buffer.concat([sighash(idlInstr.name), ...argBufs]);
  const keys: AccountMeta[] = idlInstr.accounts.map(a => {
    const info = byName[a.name] ?? byName[norm(a.name)];
    if (!info) throw new Error(`Missing account mapping for "${a.name}"`);
    return { pubkey: info.pubkey, isWritable: info.isWritable ?? !!a.isMut, isSigner: info.isSigner ?? !!a.isSigner };
  });
  return new TransactionInstruction({ programId, keys, data });
}

async function main() {
  const RPC = process.env.ANCHOR_PROVIDER_URL ?? clusterApiUrl("devnet");
  const connection = new Connection(RPC, "confirmed");

  const provider = anchor.AnchorProvider.env(); // admin/payer via ANCHOR_WALLET
  anchor.setProvider(provider);
  const admin = (provider.wallet as any).payer as Keypair;

  const buyer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8")))
  );

  const MINT = new PublicKey(process.argv[2] ?? process.env.MINT ?? (() => { throw new Error("Pass <MINT_PUBKEY>"); })());
  const buyUi    = argNum("--buy", 0.25);
  const redeemUi = argNum("--redeem", 0.10);

  // Load real IDL (for coder + exact account order)
  const idlRaw = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../target/idl/fair_token.json"), "utf8"));
  const coder  = new anchor.BorshCoder(idlRaw);

  // Find instructions (by fuzzy name)
  const buyIxIdl    = idlRaw.instructions.find((i: any) => /buy/i.test(i.name)) as IdlInstr | undefined;
  const redeemIxIdl = idlRaw.instructions.find((i: any) => /redeem/i.test(i.name)) as IdlInstr | undefined;
  if (!buyIxIdl || !redeemIxIdl) throw new Error(`buy/redeem not found in IDL. Found: ${idlRaw.instructions.map((i:any)=>i.name).join(", ")}`);

  const p = PDAS(PROGRAM_ID);

  // Preflight
  const mi = await getMint(connection, MINT, "confirmed", TOKEN_PROGRAM_ID);
  console.log("=== PRE-FLIGHT ===");
  console.log("RPC:            ", RPC);
  console.log("Admin (payer):  ", provider.wallet.publicKey.toBase58());
  console.log("Buyer:          ", buyer.publicKey.toBase58());
  console.log("Program:        ", PROGRAM_ID.toBase58());
  console.log("Mint:           ", MINT.toBase58());
  console.log("Config PDA:     ", p.config.toBase58());
  console.log("MintAuth PDA:   ", p.mintAuthority.toBase58());
  console.log("On-chain mintAuth:", mi.mintAuthority?.toBase58() ?? "null");
  console.log("Decimals/Supply:", mi.decimals, mi.supply.toString());
  if (mi.decimals !== EXPECTED_DECIMALS) console.warn(`⚠️ mint decimals ${mi.decimals} != ${EXPECTED_DECIMALS}`);

  // Read Config to get EXACT baked accounts
  const cfgAcc = await connection.getAccountInfo(p.config);
  if (!cfgAcc) throw new Error("Missing Config PDA on-chain.");
  const cfg = coder.accounts.decode("Config", cfgAcc.data);
  const keys = Object.keys(cfg);
  const getPk = (needle: string) => {
    const k = keys.find(k => norm(k).includes(needle));
    if (!k) return null;
    const v = (cfg as any)[k];
    return v instanceof PublicKey ? v : new PublicKey(v);
  };
  const cfgTokenVaultAccount = getPk("tokenvaultaccount");
  const cfgSolVault          = getPk("solvault") ?? p.solVault;
  const cfgTokenVault        = getPk("tokenvault") ?? p.tokenVault;
  if (!cfgTokenVaultAccount) throw new Error("Config.token_vault_account not found.");

  // Ensure buyer ATA exists
  const buyerAta = await getOrCreateAssociatedTokenAccount(connection, buyer, MINT, buyer.publicKey, true, "confirmed", undefined, TOKEN_PROGRAM_ID);

  console.log("\nBaked accounts:");
  console.log("  sol_vault          :", cfgSolVault.toBase58());
  console.log("  token_vault (PDA)  :", cfgTokenVault.toBase58());
  console.log("  token_vault_account:", cfgTokenVaultAccount.toBase58());
  console.log("  buyer_ata          :", buyerAta.address.toBase58());

  // Build account maps in the *IDL order* for each instruction
  const commonMap = {
    buyer: { pubkey: buyer.publicKey, isSigner: true },
    redeemer: { pubkey: buyer.publicKey, isSigner: true },
    mint: { pubkey: MINT, isWritable: true },
    mint_authority: { pubkey: p.mintAuthority },
    mintAuthority: { pubkey: p.mintAuthority },
    config: { pubkey: p.config, isWritable: true },
    sol_vault: { pubkey: cfgSolVault, isWritable: true },
    solVault: { pubkey: cfgSolVault, isWritable: true },
    token_vault: { pubkey: cfgTokenVault, isWritable: true },
    tokenVault: { pubkey: cfgTokenVault, isWritable: true },
    token_vault_account: { pubkey: cfgTokenVaultAccount, isWritable: true },
    tokenVaultAccount: { pubkey: cfgTokenVaultAccount, isWritable: true },
    user_token_account: { pubkey: buyerAta.address, isWritable: true },
    userTokenAccount: { pubkey: buyerAta.address, isWritable: true },
    token_program: { pubkey: TOKEN_PROGRAM_ID },
    tokenProgram: { pubkey: TOKEN_PROGRAM_ID },
    system_program: { pubkey: SystemProgram.programId },
    systemProgram: { pubkey: SystemProgram.programId },
  } as Record<string, { pubkey: PublicKey; isWritable?: boolean; isSigner?: boolean }>;

  const nameMap = (idlAccs: any[]) => {
    const out: Record<string, { pubkey: PublicKey; isWritable?: boolean; isSigner?: boolean }> = {};
    for (const a of idlAccs) {
      const n = a.name;
      const m = commonMap[n] ?? commonMap[norm(n)] ?? commonMap[toCamel(n)];
      if (!m) throw new Error(`Map missing for account "${n}"`);
      out[n] = m;
    }
    return out;
  };

  async function report(tag: string, sig?: string) {
    const [solVaultLamports, vaultToken, mintInfo, cfgAccInfo] = await Promise.all([
      connection.getBalance(cfgSolVault, "confirmed"),
      getAccount(connection, cfgTokenVaultAccount),
      getMint(connection, MINT),
      connection.getAccountInfo(p.config),
    ]);
    const cfgNow = coder.accounts.decode("Config", cfgAccInfo!.data);
    const finalishKey = Object.keys(cfgNow).find(k => /final/.test(k.toLowerCase()));
    const finalishVal = finalishKey ? (cfgNow as any)[finalishKey] : undefined;

    let conf: string | undefined;
    if (sig) {
      const st = await connection.getSignatureStatuses([sig]);
      conf = st.value[0]?.confirmationStatus ?? "unknown";
    }

    console.log(`\n--- ${tag} ---`);
    console.log("SOL vault lamports:", solVaultLamports.toString());
    console.log("Token vault amount:", vaultToken.amount.toString());
    console.log("Mint total supply :", mintInfo.supply.toString());
    console.log("Circulating tokens (UI):", Number(mintInfo.supply - vaultToken.amount));
    if (finalishKey) console.log(`Config.${finalishKey} :`, finalishVal);
    if (sig) console.log("Tx status         :", conf);
  }

  // ===== BUY =====
  const buyLamports = new BN(Math.floor(buyUi * LAMPORTS_PER_TOKEN));
  const buyIx = buildIx(
    PROGRAM_ID,
    buyIxIdl,
    [u64le(buyLamports)],
    nameMap(buyIxIdl.accounts)
  );
  const buySig = await sendAndConfirmTransaction(connection, new Transaction().add(buyIx), [buyer], { commitment: "confirmed" });
  await report(`after BUY (${buyUi})`, buySig);

  // ===== REDEEM =====
  const redeemLamports = new BN(Math.floor(redeemUi * LAMPORTS_PER_TOKEN));
  const redeemIx = buildIx(
    PROGRAM_ID,
    redeemIxIdl,
    [u64le(redeemLamports)],
    nameMap(redeemIxIdl.accounts)
  );
  const redeemSig = await sendAndConfirmTransaction(connection, new Transaction().add(redeemIx), [buyer], { commitment: "confirmed" });
  await report(`after REDEEM (${redeemUi})`, redeemSig);

  console.log("\n✅ Done.");
}

main().catch((e) => {
  console.error("❌ ERROR:", e.stack || e);
  process.exit(1);
});
