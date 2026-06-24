import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, Transaction, type Keypair } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  NATIVE_MINT,
} from "@solana/spl-token";
import axios from "axios";
import {
  getProgram,
  getKeypair,
  AnchorMemoType,
  hashContent,
  hashToHex,
} from "../../lib/program";
import {
  getAcpStatePda,
  getAgentFeeAuthorityPda,
  getJobPda,
  getMemoPda,
  getMemoSigPda,
  getEscrowVaultPda,
  getEscrowAuthorityPda,
  zeroHash,
} from "../../lib/pda";

import { getApiUrl } from "../../lib/config";
const API_URL = getApiUrl();
const client = axios.create({ baseURL: API_URL });

const MEMO_TYPE = {
  JobRequest: 0,
  Agreement: 1,
  Transaction: 2,
  Deliverable: 3,
  General: 4,
} as const;

function isMemoType(memo: any, type: keyof typeof MEMO_TYPE): boolean {
  if (!memo) return false;
  const numeric = MEMO_TYPE[type];
  const lower = type.charAt(0).toLowerCase() + type.slice(1);
  return memo.memoType === numeric || memo.memoType === lower || memo.memoType === type;
}

/** Fetch job details from indexer (read-only) */
export async function getJobStatus(jobId: string) {
  const { data } = await client.get(`/acp/jobs/${jobId}`);
  return data;
}

/** Fetch on-chain job state directly from Solana */
export async function getOnChainJob(jobAddress: string): Promise<{ phase: number; memoCount: number }> {
  const program = getProgram();
  const jobPda = new PublicKey(jobAddress);
  const jobAccount = await (program.account as any).job.fetch(jobPda);
  return { phase: Number(jobAccount.phase), memoCount: Number(jobAccount.memoCount) };
}

/** Fetch full on-chain job account */
export async function getOnChainJobFull(jobAddress: string): Promise<any> {
  const program = getProgram();
  const jobPda = new PublicKey(jobAddress);
  return (program.account as any).job.fetch(jobPda);
}

/** Fetch on-chain job phase directly from Solana */
export async function getOnChainPhase(jobAddress: string): Promise<number> {
  const { phase } = await getOnChainJob(jobAddress);
  return phase;
}

/** Accept or reject a job by signing the JobRequest memo */
export async function acceptOrRejectJob(
  jobId: string,
  params: { accept: boolean; reason?: string }
) {
  const program = getProgram();
  const keypair = getKeypair();

  console.log(`[seller-api] ${params.accept ? "Accepting" : "Rejecting"} job ${jobId}`);

  const job = await getJobStatus(jobId);
  const jid = Number(job.jobId);
  const agentPda = new PublicKey(job.agent);
  const jobPda = getJobPda(agentPda, jid);

  const jobRequestMemo = job.memos?.find((m: any) => isMemoType(m, "JobRequest"));
  if (!jobRequestMemo) throw new Error("No JobRequest memo to sign");

  const memoSigPda = getMemoSigPda(jobPda, BigInt(jobRequestMemo.memoId), keypair.publicKey);
  const reasonHash = params.reason ? hashContent(params.reason) : zeroHash();

  if (params.reason) {
    const hexHash = hashToHex(reasonHash);
    try {
      await client.post("/memo-content", { hash: hexHash, text: params.reason });
    } catch (e) { console.debug("[seller] memo-content POST (reject reason):", e); }
  }

  const tx = await (program.methods as any)
    .signMemo(params.accept, reasonHash)
    .accounts({
      signer: keypair.publicKey,
      acpState: getAcpStatePda(),
      agent: agentPda,
      job: jobPda,
      memo: getMemoPda(jobPda, Number(jobRequestMemo.memoId)),
      memoSignature: memoSigPda,
      escrowVault: getEscrowVaultPda(jobPda),
      systemProgram: SystemProgram.programId,
    })
    .signers([keypair])
    .rpc();

  console.log(`[seller-api] Job ${jobId} ${params.accept ? "accepted" : "rejected"}: ${tx}`);
  return { tx };
}

/** Sign a memo by its ID (generic — for signing Transaction memos etc.) */
export async function signMemoById(
  jobId: string,
  memoId: number,
  approve: boolean
) {
  const program = getProgram();
  const keypair = getKeypair();

  console.log(`[seller-api] Signing memo ${memoId} on job ${jobId} (approve=${approve})`);

  const job = await getJobStatus(jobId);
  const agentPda = new PublicKey(job.agent);
  const jobPda = getJobPda(agentPda, Number(job.jobId));
  const memoSigPda = getMemoSigPda(jobPda, BigInt(memoId), keypair.publicKey);

  const tx = await (program.methods as any)
    .signMemo(approve, zeroHash())
    .accounts({
      signer: keypair.publicKey,
      acpState: getAcpStatePda(),
      agent: agentPda,
      job: jobPda,
      memo: getMemoPda(jobPda, memoId),
      memoSignature: memoSigPda,
      escrowVault: getEscrowVaultPda(jobPda),
      systemProgram: SystemProgram.programId,
    })
    .signers([keypair])
    .rpc();

  console.log(`[seller-api] Memo ${memoId} signed on job ${jobId}: ${tx}`);
  return { tx };
}

/** Set budget + fee on a job (provider sets price) */
export async function setBudgetOnChain(
  jobId: string,
  budget: number,
  fee: number
): Promise<{ tx: string }> {
  const program = getProgram();
  const keypair = getKeypair();

  console.log(`[seller-api] Setting budget=${budget} fee=${fee} for job ${jobId}`);

  const job = await getJobStatus(jobId);
  const agentPda = new PublicKey(job.agent);
  const jobPda = getJobPda(agentPda, Number(job.jobId));

  const tx = await (program.methods as any)
    .setBudget(new anchor.BN(budget), new anchor.BN(fee))
    .accounts({
      provider: keypair.publicKey,
      agent: agentPda,
      job: jobPda,
    })
    .signers([keypair])
    .rpc();

  console.log(`[seller-api] Budget set for job ${jobId}: budget=${budget} fee=${fee} tx=${tx}`);
  return { tx };
}

/** Create a memo on a job */
export async function createMemo(
  jobId: string,
  memoType: string,
  content: string
) {
  const program = getProgram();
  const keypair = getKeypair();

  console.log(`[seller-api] Creating ${memoType} memo for job ${jobId}`);

  const job = await getJobStatus(jobId);
  const jid = Number(job.jobId);
  const agentPda = new PublicKey(job.agent);
  const jobPda = getJobPda(agentPda, jid);

  const jobAccount = await (program.account as any).job.fetch(jobPda);
  const nextMemoId = Number(jobAccount.memoCount) + 1;
  const memoPda = getMemoPda(jobPda, nextMemoId);

  const anchorType = AnchorMemoType[memoType];
  if (!anchorType) throw new Error(`Invalid memoType: ${memoType}`);

  const contentHash = hashContent(content);
  const hexHash = hashToHex(contentHash);

  try {
    await client.post("/memo-content", { hash: hexHash, text: content });
  } catch (e) { console.debug("[seller] memo-content POST (memo):", e); }

  const tx = await (program.methods as any)
    .createMemo(contentHash, anchorType, false)
    .accounts({
      sender: keypair.publicKey,
      agent: agentPda,
      job: jobPda,
      memo: memoPda,
      systemProgram: SystemProgram.programId,
    })
    .signers([keypair])
    .rpc();

  console.log(`[seller-api] Memo created for job ${jobId}: memoId=${nextMemoId} tx=${tx}`);
  return { memoId: nextMemoId, tx };
}

/** Withdraw budget from escrow into provider wallet.
 *  Returns claimed amount, payment mint, and client pubkey — used by swap and other offerings
 *  that need to operate with the escrowed funds before the job completes. */
export async function withdrawBudget(jobId: string): Promise<{
  tx: string;
  amountLamports: number;
  paymentMint: PublicKey;
  clientWallet: PublicKey;
} | null> {
  const program = getProgram();
  const keypair = getKeypair();

  console.log(`[seller-api] Withdrawing budget for job ${jobId}`);

  const job = await getJobStatus(jobId);
  const agentPda = new PublicKey(job.agent);
  const jobPda = getJobPda(agentPda, Number(job.jobId));

  const jobAccount = await (program.account as any).job.fetch(jobPda);
  const claimable = Number(jobAccount.budget) - Number(jobAccount.amountClaimed);
  if (claimable <= 0) {
    console.log(`[seller-api] Job ${jobId} — nothing to withdraw (already claimed)`);
    return null;
  }

  const escrowVault = getEscrowVaultPda(jobPda);
  const escrowInfo = await program.provider.connection.getAccountInfo(escrowVault);
  if (!escrowInfo) {
    console.log(`[seller-api] Job ${jobId} — escrow not initialized`);
    return null;
  }
  const escrowBalance = Buffer.from(escrowInfo.data).readBigUInt64LE(64);
  if (escrowBalance === 0n) {
    console.log(`[seller-api] Job ${jobId} — escrow empty`);
    return null;
  }

  const escrowAuthority = getEscrowAuthorityPda(jobPda);
  const paymentMint: PublicKey = jobAccount.paymentMint;
  const providerAta = getAssociatedTokenAddressSync(paymentMint, keypair.publicKey);

  const createProviderAta = createAssociatedTokenAccountIdempotentInstruction(
    keypair.publicKey,
    providerAta,
    keypair.publicKey,
    paymentMint
  );

  const tx = await (program.methods as any)
    .claimBudget(new anchor.BN(claimable))
    .accounts({
      provider: keypair.publicKey,
      agent: agentPda,
      job: jobPda,
      escrowVault,
      escrowAuthority,
      providerTokenAccount: providerAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .preInstructions([createProviderAta])
    .signers([keypair])
    .rpc();

  console.log(`[seller-api] Budget withdrawn for job ${jobId}: ${claimable} lamports, tx=${tx}`);
  return {
    tx,
    amountLamports: claimable,
    paymentMint,
    clientWallet: jobAccount.client,
  };
}

/** Claim budget from escrow (provider takes from budget) — legacy wrapper */
export async function claimBudget(jobId: string): Promise<{ tx: string | null; skipped?: boolean }> {
  const result = await withdrawBudget(jobId);
  if (!result) return { tx: null, skipped: true };
  return { tx: result.tx };
}

/** Push tokens from the provider's payment-mint ATA back into job escrow. */
export async function refundBudget(
  jobId: string,
  amountLamports: number | bigint
): Promise<{ tx: string }> {
  const program = getProgram();
  const keypair = getKeypair();

  const job = await getJobStatus(jobId);
  const agentPda = new PublicKey(job.agent);
  const jobPda = getJobPda(agentPda, Number(job.jobId));

  const jobAccount = await (program.account as any).job.fetch(jobPda);
  const paymentMint: PublicKey = jobAccount.paymentMint;
  const providerAta = getAssociatedTokenAddressSync(paymentMint, keypair.publicKey);

  console.log(`[seller-api] Refunding ${amountLamports} lamports to escrow for job ${jobId}`);

  const tx = await (program.methods as any)
    .refundBudget(new anchor.BN(amountLamports.toString()))
    .accounts({
      provider: keypair.publicKey,
      agent: agentPda,
      job: jobPda,
      escrowVault: getEscrowVaultPda(jobPda),
      providerTokenAccount: providerAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([keypair])
    .rpc();

  console.log(`[seller-api] Refunded ${amountLamports} lamports for job ${jobId}: tx=${tx}`);
  return { tx };
}

const WRAP_REFUND_TX_FEE_LAMPORTS = 10_000;

/** Refund leftover native SOL from a per-job wallet through ACP escrow. */
export async function refundJobWalletViaAcp(
  jobAddress: string,
  jobKeypair: Keypair
): Promise<{ refundLamports: number; wrapTx: string; refundTx: string } | null> {
  const program = getProgram();
  const providerKp = getKeypair();
  const connection = program.provider.connection;

  const balance = await connection.getBalance(jobKeypair.publicKey, "confirmed");
  if (balance <= WRAP_REFUND_TX_FEE_LAMPORTS) return null;
  const refundLamports = balance - WRAP_REFUND_TX_FEE_LAMPORTS;

  const providerWsolAta = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    providerKp.publicKey
  );

  const wrapTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: jobKeypair.publicKey,
      toPubkey: providerKp.publicKey,
      lamports: refundLamports,
    }),
    createAssociatedTokenAccountIdempotentInstruction(
      providerKp.publicKey,
      providerWsolAta,
      providerKp.publicKey,
      NATIVE_MINT
    ),
    SystemProgram.transfer({
      fromPubkey: providerKp.publicKey,
      toPubkey: providerWsolAta,
      lamports: refundLamports,
    }),
    createSyncNativeInstruction(providerWsolAta)
  );
  wrapTx.feePayer = providerKp.publicKey;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  wrapTx.recentBlockhash = blockhash;
  wrapTx.lastValidBlockHeight = lastValidBlockHeight;
  wrapTx.sign(providerKp, jobKeypair);

  const wrapSig = await connection.sendRawTransaction(wrapTx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  const wrapRes = await connection.confirmTransaction(
    { signature: wrapSig, blockhash, lastValidBlockHeight },
    "confirmed"
  );
  if (wrapRes.value.err) {
    throw new Error(
      `wrap to provider WSOL ATA failed: ${JSON.stringify(wrapRes.value.err)}`
    );
  }

  const { tx: refundTxSig } = await refundBudget(jobAddress, refundLamports);
  console.log(
    `[seller-api] Job ${jobAddress} — refunded ${refundLamports} lamports via ACP (wrap=${wrapSig} refund=${refundTxSig})`
  );
  return { refundLamports, wrapTx: wrapSig, refundTx: refundTxSig };
}

/** Claim fee from escrow — returns unused fee to client + protocol share to treasury */
export async function claimFee(jobId: string): Promise<{ tx: string | null; skipped?: boolean }> {
  const program = getProgram();
  const keypair = getKeypair();

  const job = await getJobStatus(jobId);
  const agentPda = new PublicKey(job.agent);
  const jobPda = getJobPda(agentPda, Number(job.jobId));

  const jobAccount = await (program.account as any).job.fetch(jobPda);
  if (Number(jobAccount.fee) <= 0) {
    console.log(`[seller-api] Job ${jobId} — no fee to claim`);
    return { tx: null, skipped: true };
  }

  const acpStatePda = getAcpStatePda();
  const escrowVault = getEscrowVaultPda(jobPda);
  const escrowAuthority = getEscrowAuthorityPda(jobPda);

  const acpState = await (program.account as any).acpState.fetch(acpStatePda);
  // `acpState.platformTreasury` already IS the ATA (set by initialize_acp).
  // Deriving another ATA off it yields a non-existent account → #3012.
  const platformTreasuryAta: PublicKey = acpState.platformTreasury;
  const paymentMint: PublicKey = jobAccount.paymentMint;

  const clientAta = getAssociatedTokenAddressSync(paymentMint, new PublicKey(job.client));
  const agentFeeAuthority = getAgentFeeAuthorityPda(agentPda);
  const agentFeeVault = getAssociatedTokenAddressSync(paymentMint, agentFeeAuthority, true);

  const tx = await (program.methods as any)
    .claimFee()
    .accounts({
      claimer: keypair.publicKey,
      acpState: acpStatePda,
      agent: agentPda,
      job: jobPda,
      escrowVault,
      escrowAuthority,
      clientTokenAccount: clientAta,
      platformTreasuryTokenAccount: platformTreasuryAta,
      paymentMint,
      agentFeeAuthority,
      agentFeeVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([keypair])
    .rpc();

  console.log(`[seller-api] Fee claimed for job ${jobId}: tx=${tx}`);
  return { tx };
}

const NATIVE_MINT_STR = "So11111111111111111111111111111111111111112";

/** Close provider WSOL ATA and transfer native SOL to a destination in one tx. */
export async function unwrapAndTransferSol(
  destination: PublicKey,
  lamports: number | bigint
): Promise<string> {
  const keypair = getKeypair();
  const connection = getProgram().provider.connection;

  const wsolAta = getAssociatedTokenAddressSync(
    new PublicKey(NATIVE_MINT_STR),
    keypair.publicKey
  );

  const tx = new Transaction().add(
    createCloseAccountInstruction(wsolAta, keypair.publicKey, keypair.publicKey),
    SystemProgram.transfer({
      fromPubkey: keypair.publicKey,
      toPubkey: destination,
      lamports: BigInt(lamports),
    })
  );
  tx.feePayer = keypair.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(keypair);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
    preflightCommitment: "confirmed",
  });
  await connection.confirmTransaction(sig, "confirmed");

  console.log(
    `[seller-api] Unwrapped WSOL ATA and sent ${lamports} lamports to ${destination.toBase58()}: ${sig}`
  );
  return sig;
}

/** Transfer SPL tokens (or native SOL) from provider wallet to a destination wallet.
 *  If closeSourceAta=true, appends a CloseAccount ix to reclaim rent (only for SPL, not SOL). */
export async function transferToken(
  mint: PublicKey,
  destinationWallet: PublicKey,
  amountLamports: number | bigint,
  closeSourceAta: boolean = false,
): Promise<string> {
  const keypair = getKeypair();
  const connection = getProgram().provider.connection;
  const tx = new Transaction();

  if (mint.toBase58() === NATIVE_MINT_STR) {
    // Native SOL transfer (Jupiter unwraps WSOL → SOL after swap)
    tx.add(
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: destinationWallet,
        lamports: BigInt(amountLamports),
      })
    );
  } else {
    const sourceAta = getAssociatedTokenAddressSync(mint, keypair.publicKey);
    const destAta = getAssociatedTokenAddressSync(mint, destinationWallet);

    // If closing the ATA after transfer, always use the actual ATA balance.
    // The quoted outAmount from Jupiter may differ from actual received (slippage/rounding).
    // Using real balance guarantees balance=0 before CloseAccount and avoids "insufficient funds".
    let transferAmount = BigInt(amountLamports);
    if (closeSourceAta) {
      try {
        const balanceResp = await connection.getTokenAccountBalance(sourceAta, "confirmed");
        const fullBalance = BigInt(balanceResp.value.amount);
        if (fullBalance !== transferAmount) {
          console.log(`[seller-api] ATA has ${fullBalance} but expected ${transferAmount} — using actual balance`);
        }
        transferAmount = fullBalance;
      } catch { /* ATA might not exist yet, proceed with original amount */ }
    }

    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        keypair.publicKey,
        destAta,
        destinationWallet,
        mint
      ),
      createTransferInstruction(
        sourceAta,
        destAta,
        keypair.publicKey,
        transferAmount,
      ),
    );

    if (closeSourceAta) {
      tx.add(
        createCloseAccountInstruction(sourceAta, keypair.publicKey, keypair.publicKey)
      );
    }
  }

  tx.feePayer = keypair.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(keypair);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
    preflightCommitment: "confirmed",
  });
  await connection.confirmTransaction(sig, "confirmed");

  console.log(`[seller-api] Transferred ${amountLamports} of ${mint.toBase58()} to ${destinationWallet.toBase58()}${closeSourceAta ? " (closed source ATA)" : ""}: ${sig}`);
  return sig;
}
