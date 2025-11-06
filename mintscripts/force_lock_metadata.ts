import fs from "fs";
import { Keypair } from "@solana/web3.js";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { keypairIdentity, none, publicKey as pk } from "@metaplex-foundation/umi";
import { fromWeb3JsKeypair } from "@metaplex-foundation/umi-web3js-adapters";
import { mplTokenMetadata, fetchMetadataFromSeeds, updateV1 } from "@metaplex-foundation/mpl-token-metadata";

const RPC = process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";
const ADMIN_PATH = "./throwawayadmin.json";
const MINT_PATH  = "./throwawaymint.json";

const load = (p:string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p,"utf8"))));

(async () => {
  const admin = load(ADMIN_PATH);
  const mint  = load(MINT_PATH).publicKey;

  // Use Umi + admin as signer
  const umi = createUmi(RPC).use(mplTokenMetadata());
  umi.use(keypairIdentity(fromWeb3JsKeypair(admin)));

  // Read current metadata (finalized re-fetch by doing two reads with a tiny delay)
  const read = async () => await fetchMetadataFromSeeds(umi, { mint: pk(mint) });
  let md = await read();
  console.log("Before:", {
    mint: mint.toBase58(),
    updateAuthority: md.updateAuthority ? md.updateAuthority.toString() : null,
  });

  // If already null, done
  if (!md.updateAuthority) {
    console.log("Already locked ✅");
    return;
  }

  // Enforce that admin is the current UA (otherwise, abort)
  if (md.updateAuthority.toString() !== admin.publicKey.toBase58()) {
    throw new Error(`Refusing to lock: on-chain UA=${md.updateAuthority.toString()}, expected admin=${admin.publicKey.toBase58()}`);
  }

  // Send lock
  const sig = await updateV1(umi, {
    mint: pk(mint),
    authority: umi.identity,
    newUpdateAuthority: none(),
  }).sendAndConfirm(umi);
  console.log("Lock tx:", sig);

  // Small wait, then re-read
  await new Promise(r => setTimeout(r, 1200));
  md = await read();

  console.log("After:", {
    updateAuthority: md.updateAuthority ? md.updateAuthority.toString() : null,
  });
})();
