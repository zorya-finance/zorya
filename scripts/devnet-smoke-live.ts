#!/usr/bin/env npx ts-node
/**
 * Live Devnet smoke: fake USDC + fake wSOL / JitoSOL / cbBTC, Pyth pull, lend/borrow/repay/withdraw.
 * Never mainnet. Never real USDC / wSOL / JitoSOL / cbBTC mints.
 */
import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, BN, Program, Wallet, type Idl } from "@coral-xyz/anchor";
import { HermesClient } from "@pythnetwork/hermes-client";
import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";
import {
  createAssociatedTokenAccountIdempotent,
  createMint,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { Zorya } from "../target/types/zorya";
import { ZoryaClient } from "../sdk/src";
import {
  BTC_USD_FEED_HEX,
  JITOSOL_USD_FEED_HEX,
  SOL_USD_FEED_HEX,
  feedIdFromHex,
} from "../sdk/src/pyth";

const URL = process.env.SOLANA_URL ?? "https://api.devnet.solana.com";
const WALLET_PATH =
  process.env.ANCHOR_WALLET ?? resolve(__dirname, "../.keys/id.json");
const FACE = new BN(20_000_000); // 20 USDC face
const TICK = 256;
const MIN_FILL = new BN(1_000_000);
const HERMES_URLS = [
  "https://pyth.dourolabs.app/hermes",
  "https://hermes.pyth.network",
];
const TENOR = {
  id: "2026-12-31",
  unix: "2026-12-31T00:00:00Z",
} as const;

const PAIRS = [
  {
    id: "wsol-usdc",
    label: "fake wSOL",
    decimals: 9,
    lltvBps: 7000,
    feedHex: SOL_USD_FEED_HEX,
    oracleSymbol: "Crypto.SOL/USD",
    depositAtoms: 10n * 1_000_000_000n,
    faucet: 20,
  },
  {
    id: "jitosol-usdc",
    label: "fake JitoSOL",
    decimals: 9,
    lltvBps: 7000,
    feedHex: JITOSOL_USD_FEED_HEX,
    oracleSymbol: "Crypto.JITOSOL/USD",
    depositAtoms: 10n * 1_000_000_000n,
    faucet: 20,
  },
  {
    id: "cbbtc-usdc",
    label: "fake cbBTC",
    decimals: 8,
    lltvBps: 6500,
    // Hermes trial grants BTC/USD, not Crypto.CBBTC/USD.
    feedHex: BTC_USD_FEED_HEX,
    oracleSymbol: "Crypto.BTC/USD",
    depositAtoms: 1n * 100_000_000n,
    faucet: 1,
  },
] as const;

function refuseMainnet(url: string) {
  if (url.includes("mainnet")) {
    throw new Error("refusing to run against mainnet");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimit(err: unknown): boolean {
  return /429|Too many requests/i.test(
    err instanceof Error ? err.message : String(err),
  );
}

async function withRpcRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let i = 0; i < 8; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!isRateLimit(err) || i === 7) throw err;
      console.log(label, "429, retry", i + 1);
      await sleep(2_500 * (i + 1));
    }
  }
  throw last;
}

function loadPayer(): Keypair {
  const raw = JSON.parse(readFileSync(WALLET_PATH, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function hermesHeaders(): Record<string, string> {
  const key = process.env.PYTH_API_KEY;
  if (!key) {
    throw new Error(
      "Set PYTH_API_KEY (Pyth Terminal). Hermes requires a Bearer token since August 2026.",
    );
  }
  return { Authorization: `Bearer ${key}` };
}

async function fetchHermesUpdate(feedHex: string): Promise<string[]> {
  const feed = `0x${feedHex}`;
  const headers = hermesHeaders();
  let last = "";
  for (const base of HERMES_URLS) {
    try {
      const hermes = new HermesClient(base, { headers, timeout: 15_000 });
      const updates = await hermes.getLatestPriceUpdates([feed], {
        encoding: "base64",
      });
      const data = updates.binary?.data;
      if (data && data.length > 0) return data;
      last = `${base}: empty update`;
    } catch (err) {
      last = `${base}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  throw new Error(`Hermes price update failed for ${feedHex} (${last})`);
}

async function withPythPrice(
  connection: Connection,
  wallet: Wallet,
  feedHex: string,
  extraSigners: Keypair[],
  consume: (priceUpdate: PublicKey) => Promise<TransactionInstruction[]>,
): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const data = await fetchHermesUpdate(feedHex);
      const receiver = new PythSolanaReceiver({ connection, wallet });
      const builder = receiver.newTransactionBuilder({
        closeUpdateAccounts: true,
      });
      await builder.addPostPriceUpdates(data);
      const feed = `0x${feedHex}`;
      await builder.addPriceConsumerInstructions(async (getAccount) => {
        const priceUpdate =
          getAccount(feed) ??
          getAccount(feedHex) ??
          getAccount(feed.toLowerCase());
        if (!priceUpdate) {
          throw new Error(`Pyth receiver did not expose ${feedHex}`);
        }
        const ixs = await consume(priceUpdate);
        return ixs.map((instruction) => ({
          instruction,
          signers: extraSigners,
          computeUnits: 800_000,
        }));
      });
      const txs = await builder.buildVersionedTransactions({
        computeUnitPriceMicroLamports: 50_000,
      });
      await receiver.provider.sendAll(txs, {
        skipPreflight: false,
        commitment: "confirmed",
      });
      return;
    } catch (err) {
      last = err;
      if (!isRateLimit(err) || attempt === 4) throw err;
      console.log("RPC 429, retry", attempt + 1);
      await sleep(3_000 * (attempt + 1));
    }
  }
  throw last;
}

async function main() {
  refuseMainnet(URL);
  const payer = loadPayer();
  const connection = new Connection(URL, "confirmed");
  const wallet = new Wallet(payer);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const idl = JSON.parse(
    readFileSync(resolve(__dirname, "../target/idl/zorya.json"), "utf8"),
  ) as Idl;
  const program = new Program(idl as Zorya, provider);
  const client = new ZoryaClient(program);
  const owner = payer.publicKey;

  console.log("RPC     ", URL);
  console.log("Wallet  ", owner.toBase58());
  console.log("Program ", program.programId.toBase58());

  const config = client.pdas.config();
  const existing = await connection.getAccountInfo(config);
  if (!existing) {
    await client.initializeConfig(owner);
    console.log("initialized config", config.toBase58());
  } else {
    console.log("config exists", config.toBase58());
  }

  const resumeLoan = process.env.DEVNET_LOAN_MINT;
  const resumeOnly = process.env.DEVNET_ONLY;
  const resumeCollaterals = JSON.parse(
    process.env.DEVNET_COLLATERALS ?? "{}",
  ) as Record<string, string>;
  const seedDesk = process.env.DEVNET_SEED_JSON
    ? (JSON.parse(process.env.DEVNET_SEED_JSON) as {
        pairs?: unknown[];
        markets?: unknown[];
      })
    : { pairs: [], markets: [] };

  const loanMint = resumeLoan
    ? new PublicKey(resumeLoan)
    : await createMint(connection, payer, owner, null, 6);
  const maturity = new BN(Math.floor(Date.parse(TENOR.unix) / 1000));
  console.log("loan    ", loanMint.toBase58(), "(fake USDC)");

  const borrower = Keypair.generate();
  const fundIx = SystemProgram.transfer({
    fromPubkey: owner,
    toPubkey: borrower.publicKey,
    lamports: Math.round(0.2 * LAMPORTS_PER_SOL),
  });
  await provider.sendAndConfirm(new anchor.web3.Transaction().add(fundIx), [
    payer,
  ]);

  const lenderLoan = await createAssociatedTokenAccountIdempotent(
    connection,
    payer,
    loanMint,
    owner,
  );
  const borrowerLoan = await createAssociatedTokenAccountIdempotent(
    connection,
    payer,
    loanMint,
    borrower.publicKey,
  );
  await mintTo(connection, payer, loanMint, lenderLoan, payer, 2_000n * 1_000_000n);
  await mintTo(connection, payer, loanMint, borrowerLoan, payer, 400n * 1_000_000n);
  if (!resumeLoan) {
    console.log("cooling public RPC…");
    await sleep(10_000);
  }

  const pairsOut = [...(seedDesk.pairs ?? [])];
  const markets = [...(seedDesk.markets ?? [])];

  for (const pair of PAIRS) {
    if (resumeOnly && pair.id !== resumeOnly) continue;
    const existingCollat = resumeCollaterals[pair.id];
    const collateralMint = existingCollat
      ? new PublicKey(existingCollat)
      : await withRpcRetry(`${pair.id} mint`, () =>
          createMint(connection, payer, owner, null, pair.decimals),
        );
    const marketPk = client.pdas.market(
      collateralMint,
      loanMint,
      maturity,
      pair.lltvBps,
    );
    const keys = existingCollat
      ? {
          market: marketPk,
          loanVault: client.pdas.loanVault(marketPk),
          collateralVault: client.pdas.collateralVault(marketPk),
          curve: client.pdas.curve(collateralMint, loanMint),
          mockPrice: client.pdas.mockPrice(marketPk),
        }
      : await withRpcRetry(`${pair.id} createMarket`, () =>
          client.createMarket({
            authority: owner,
            collateralMint,
            loanMint,
            maturity,
            lltvBps: pair.lltvBps,
            minFillUnits: MIN_FILL,
            oracleFeedId: feedIdFromHex(pair.feedHex),
          }),
        );
    const market = await withRpcRetry(`${pair.id} fetch market`, () =>
      program.account.termMarket.fetch(keys.market),
    );
    if (Number(market.oracleKind) !== 1) {
      throw new Error(`${pair.id}: expected Pyth market, got ${market.oracleKind}`);
    }
    console.log("market  ", pair.id, keys.market.toBase58());
    console.log("collat  ", collateralMint.toBase58(), `(${pair.label})`);
    console.log("oracle  ", pair.oracleSymbol);

    const borrowerColl = await withRpcRetry(`${pair.id} ata`, () =>
      createAssociatedTokenAccountIdempotent(
        connection,
        payer,
        collateralMint,
        borrower.publicKey,
      ),
    );
    await withRpcRetry(`${pair.id} mintTo`, () =>
      mintTo(
        connection,
        payer,
        collateralMint,
        borrowerColl,
        payer,
        pair.depositAtoms,
      ),
    );

    await withRpcRetry(`${pair.id} deposit`, () =>
      client.depositCollateral({
        owner: borrower.publicKey,
        market: keys.market,
        collateralMint,
        ownerCollateral: borrowerColl,
        collateralVault: keys.collateralVault,
        amount: new BN(pair.depositAtoms.toString()),
        signers: [borrower],
      }),
    );
    console.log("deposited", pair.id);
    await sleep(1_500);

    const { quote, quoteVault } = await withRpcRetry(`${pair.id} quote`, () =>
      client.createQuote({
        maker: owner,
        market: keys.market,
        loanMint,
        makerLoan: lenderLoan,
        seq: new BN(1),
        tick: TICK,
        units: FACE,
        signers: [payer],
      }),
    );
    console.log("quoted   ", pair.id, FACE.toString(), "@ tick", TICK);
    await sleep(1_500);

    await withPythPrice(
      connection,
      wallet,
      pair.feedHex,
      [borrower],
      async (priceUpdate) => {
        const ix = await program.methods
          .fillQuote(FACE)
          .accountsPartial({
            taker: borrower.publicKey,
            config,
            market: keys.market,
            collateralMint,
            quote,
            quoteVault,
            takerLoan: borrowerLoan,
            makerLoan: lenderLoan,
            claim: client.pdas.claim(keys.market, owner),
            obligation: client.pdas.obligation(keys.market, borrower.publicKey),
            mockPrice: keys.mockPrice,
            priceUpdate,
            curve: keys.curve,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .instruction();
        return [ix];
      },
    );
    const debt = await withRpcRetry(`${pair.id} fetch debt`, () =>
      program.account.obligationPosition.fetch(
        client.pdas.obligation(keys.market, borrower.publicKey),
      ),
    );
    if (!debt.debtUnits.eq(FACE)) {
      throw new Error(`${pair.id} fill failed: debt=${debt.debtUnits.toString()}`);
    }
    console.log("filled   ", pair.id, "with", pair.oracleSymbol);

    await withRpcRetry(`${pair.id} repay`, () =>
      client.repay({
        owner: borrower.publicKey,
        market: keys.market,
        ownerLoan: borrowerLoan,
        loanVault: keys.loanVault,
        units: FACE,
        signers: [borrower],
      }),
    );
    const afterRepay = await withRpcRetry(`${pair.id} fetch repay`, () =>
      program.account.obligationPosition.fetch(
        client.pdas.obligation(keys.market, borrower.publicKey),
      ),
    );
    if (!afterRepay.debtUnits.eqn(0)) {
      throw new Error(`${pair.id} repay left residual debt`);
    }
    console.log("repaid   ", pair.id);

    await withPythPrice(
      connection,
      wallet,
      pair.feedHex,
      [borrower],
      async (priceUpdate) => {
        const ix = await program.methods
          .withdrawCollateral(new BN(pair.depositAtoms.toString()))
          .accountsPartial({
            owner: borrower.publicKey,
            config,
            market: keys.market,
            collateralMint,
            mockPrice: keys.mockPrice,
            priceUpdate,
            ownerCollateral: borrowerColl,
            collateralVault: keys.collateralVault,
            obligation: client.pdas.obligation(keys.market, borrower.publicKey),
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .instruction();
        return [ix];
      },
    );
    const afterWithdraw = await withRpcRetry(`${pair.id} fetch withdraw`, () =>
      program.account.obligationPosition.fetch(
        client.pdas.obligation(keys.market, borrower.publicKey),
      ),
    );
    if (!afterWithdraw.collateralAmount.eqn(0)) {
      throw new Error(`${pair.id} withdraw left residual collateral`);
    }
    console.log("withdrew ", pair.id);
    await sleep(8_000);

    pairsOut.push({
      id: pair.id,
      collateralMint: collateralMint.toBase58(),
      decimals: pair.decimals,
      faucet: pair.faucet,
      oracleSymbol: pair.oracleSymbol,
      oracleFeedId: pair.feedHex,
    });
    markets.push({
      pair: pair.id,
      tenor: TENOR.id,
      market: keys.market.toBase58(),
      loanVault: keys.loanVault.toBase58(),
      collateralVault: keys.collateralVault.toBase58(),
      curve: keys.curve.toBase58(),
      mockPrice: keys.mockPrice.toBase58(),
      collateralMint: collateralMint.toBase58(),
      maturity: maturity.toNumber(),
      lltvBps: pair.lltvBps,
      collateralDecimals: pair.decimals,
      oracleSymbol: pair.oracleSymbol,
      oracleFeedId: pair.feedHex,
    });
  }

  const out = {
    cluster: "devnet",
    rpc: URL,
    programId: program.programId.toBase58(),
    config: config.toBase58(),
    loanMint: loanMint.toBase58(),
    pairs: pairsOut,
    markets,
    note: "Fake mints. No real TVL. cbBTC uses BTC/USD (Hermes trial has no CBBTC grant).",
  };
  const dest = resolve(__dirname, "../.devnet-desk.json");
  writeFileSync(dest, JSON.stringify(out, null, 2) + "\n");
  const publicDest = resolve(__dirname, "../../frontend/public/devnet-desk.json");
  if (existsSync(resolve(__dirname, "../../frontend"))) {
    mkdirSync(dirname(publicDest), { recursive: true });
    writeFileSync(publicDest, JSON.stringify(out, null, 2) + "\n");
    console.log("wrote    ", publicDest);
  }
  console.log("wrote    ", dest);
  console.log("SMOKE OK", markets.length, "markets");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
