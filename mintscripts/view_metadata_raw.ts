import fs from "fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
// CJS-safe load (works across versions)
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const mpl = require("@metaplex-foundation/mpl-token-metadata"); // has deserializeMetadata

const RPC  = process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";
const MINT = "./throwawaymint.json";

const load = (p: string) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));

(async () => {
  const connection = new Connection(RPC, "finalized");
  const mint = load(MINT).publicKey;

  // derive metadata PDA
  const TM = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
  const [metadataPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), TM.toBuffer(), mint.toBuffer()],
    TM
  );

  const acc = await connection.getAccountInfo(metadataPda, "finalized");
  if (!acc) {
    console.error("Metadata account not found.");
    process.exit(1);
  }

  // Newer builds expose deserializeMetadata(data)
  // Older builds expose Metadata.deserialize(data)
  const md =
    (typeof mpl.deserializeMetadata === "function"
      ? mpl.deserializeMetadata(acc.data)
      : mpl.Metadata.deserialize(acc.data)[0]);

  // normalize prints
  const ua = md.updateAuthority?.toBase58?.() ?? md.updateAuthority ?? null;
  const isMutable =
    typeof md.isMutable === "boolean"
      ? md.isMutable
      : (md.data?.isMutable ?? md.is_mutable ?? undefined);

  console.log("Mint:", mint.toBase58());
  console.log("Metadata PDA:", metadataPda.toBase58());
  console.log("updateAuthority:", ua);   // should be null after lock
  if (typeof isMutable !== "undefined") {
    console.log("isMutable:", isMutable); // should be false if we set it
  }
})();
