import fs from "fs";
import { Keypair } from "@solana/web3.js";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { keypairIdentity, none, publicKey as pk } from "@metaplex-foundation/umi";
import { fromWeb3JsKeypair } from "@metaplex-foundation/umi-web3js-adapters";
import { mplTokenMetadata, fetchMetadataFromSeeds, updateV1 } from "@metaplex-foundation/mpl-token-metadata";

const RPC = process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";
const ADMIN = "./throwawayadmin.json";
const MINT  = "./throwawaymint.json";

const load = (p: string) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));

async function fetchUA() {
  const umi = createUmi(RPC).use(mplTokenMetadata());
  const mintPk = load(MINT).publicKey;
  const md = await fetchMetadataFromSeeds(umi, { mint: pk(mintPk) });
  return { mintPk, ua: md.updateAuthority ? md.updateAuthority.toString() : null };
}

(async () => {
  const admin = load(ADMIN);
  const mintPk = load(MINT).publicKey;

  // 1) Show current
  let { ua } = await fetchUA();
  console.log("Before:", { mint: mintPk.toBase58(), updateAuthority: ua });

  if (ua === null) {
    console.log("Already locked ✅");
    return;
  }
  if (ua !== admin.publicKey.toBase58()) {
    throw new Error(`Refusing to lock: on-chain UA=${ua}, expected admin=${admin.publicKey.toBase58()}`);
  }

  // 2) Lock with FINALIZED confirmation
  const umi = createUmi(RPC).use(mplTokenMetadata());
  umi.use(keypairIdentity(fromWeb3JsKeypair(admin)));

  await updateV1(umi, {
    mint: pk(mintPk),
    authority: umi.identity,
    newUpdateAuthority: none(),
  }).sendAndConfirm(umi, { confirm: { commitment: "finalized" } });

  // 3) Poll until finalized state shows UA = null (up to ~10s)
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    ({ ua } = await fetchUA());
    if (ua === null) break;
  }

  console.log("After:", { updateAuthority: ua });
  if (ua !== null) throw new Error("Lock did not take effect yet; try again in a minute (devnet lag).");
})();
