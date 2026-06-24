import { getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import { output, field, heading, log } from "../lib/output";
import { getKeypair, getProgram, getConnection } from "../lib/program";
import { getAcpStatePda } from "../lib/pda";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";

export async function address() {
  const keypair = getKeypair();
  output({ wallet: keypair.publicKey.toBase58() }, (d) => {
    heading("Wallet");
    field("Address", d.wallet);
  });
}

export async function balance() {
  const keypair = getKeypair();
  const program = getProgram();
  const connection = (program.provider as anchor.AnchorProvider).connection;

  const wallet = keypair.publicKey;
  const solBalance = await connection.getBalance(wallet);

  let usdcBalance = "0";
  try {
    const acpState = await (program.account as any).acpState.fetch(getAcpStatePda());
    const mint: PublicKey = acpState.paymentToken;
    const ata = getAssociatedTokenAddressSync(mint, wallet);
    const tokenAccount = await getAccount(connection, ata);
    usdcBalance = tokenAccount.amount.toString();
  } catch (e) { console.debug("[wallet] USDC balance fetch:", e); }

  output(
    { wallet: wallet.toBase58(), sol: solBalance / 1e9, solLamports: solBalance, usdc: usdcBalance },
    (d) => {
      heading("Wallet Balance");
      field("Address", d.wallet);
      field("SOL", d.sol);
      field("USDC (raw)", d.usdc);
    }
  );
}

export async function airdrop(amount?: number) {
  const keypair = getKeypair();
  const connection = getConnection();
  const wallet = keypair.publicKey;
  const sol = amount || 1;

  log(`  Requesting ${sol} SOL airdrop to ${wallet.toBase58()}...`);

  try {
    const sig = await connection.requestAirdrop(wallet, sol * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
    output({ success: true, signature: sig, amount: sol }, (d) => {
      heading("Airdrop");
      field("Amount", `${d.amount} SOL`);
      field("Signature", d.signature);
    });
  } catch (e: any) {
    output({ error: e.message }, () => {
      log(`  Airdrop failed: ${e.message}`);
      log("  Airdrop only works on devnet/localnet. For mainnet, transfer SOL manually.\n");
    });
  }
}
