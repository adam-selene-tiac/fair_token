import fs from "fs";
import {
  Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction
} from "@solana/web3.js";
import { createUpdateMetadataAccountV2Instruction } from "@metaplex-foundation/mpl-token-metadata";

const RPC = process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";
const ADMIN = "./throwawayadmin.json";
const MINT  = "./throwawaymint.json";

const load = (p: string) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));

(async () => {
  const connection = new Connection(RPC, "finalized");
  const admin = load(ADMIN);
  const mint = load(MINT).publicKey;

  // derive metadata PDA
  const TM = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
  const [metadataPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), TM.toBuffer(), mint.toBuffer()],
    TM
  );

  console.log("Mint:", mint.toBase58());
  console.log("Metadata PDA:", metadataPda.toBase58());
  console.log("Admin (signer):", admin.publicKey.toBase58());

  // build V2 update: burn UA + make immutable
  const ix = createUpdateMetadataAccountV2Instruction(
    {
      metadata: metadataPda,
      updateAuthority: admin.publicKey,
    },
    {
      updateMetadataAccountArgsV2: {
        data: null,
        updateAuthority: null,   // burn (lock)
        primarySaleHappened: null,
        isMutable: false,        // hard-lock flag
      },
    }
  );

  const sig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(ix),
    [admin],
    { commitment: "finalized" }
  );
  console.log("Lock tx (finalized):", sig);

  // verify using Umi decoder
  const { createUmi } = await import("@metaplex-foundation/umi-bundle-defaults");
  const { publicKey: pk } = await import("@metaplex-foundation/umi");
  const { mplTokenMetadata, fetchMetadataFromSeeds } =
    await import("@metaplex-foundation/mpl-token-metadata");
  const umi = createUmi(RPC).use(mplTokenMetadata());
  const md = await fetchMetadataFromSeeds(umi, { mint: pk(mint) });
  console.log("After:", {
    updateAuthority: md.updateAuthority ? md.updateAuthority.toString() : null,
  });
})();
