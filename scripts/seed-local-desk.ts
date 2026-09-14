import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  createAssociatedTokenAccount,
  createMint,
  mintTo,
} from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { writeFileSync } from "fs";
import { resolve } from "path";
import { Zorya } from "../target/types/zorya";
import { ZoryaClient } from "../sdk/src";
import { MIN_FILL, airdrop, createTestMarket, ensureConfig } from "../tests/helpers";

const PAIRS = [
  { id: "wsol-usdc", decimals: 9, lltvBps: 7000, mark: 200, faucet: 20 },
  { id: "jitosol-usdc", decimals: 9, lltvBps: 7000, mark: 240, faucet: 20 },
  { id: "cbbtc-usdc", decimals: 8, lltvBps: 6500, mark: 64_000, faucet: 1 },
] as const;

const TENORS = [
  { id: "2026-12-31", unix: "2026-12-31T00:00:00Z" },
  { id: "2027-03-31", unix: "2027-03-31T00:00:00Z" },
  { id: "2027-06-30", unix: "2027-06-30T00:00:00Z" },
] as const;

const FACE = (n: number) => new BN(n * 1_000_000);

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Zorya as Program<Zorya>;
  const client = new ZoryaClient(program);
  const payer = (provider.wallet as anchor.Wallet).payer as Keypair;
  const connection = provider.connection;

  const config = await ensureConfig(program);
  const loanMint = await createMint(connection, payer, payer.publicKey, null, 6);

  const collaterals: Record<string, string> = {};
  for (const pair of PAIRS) {
    const mint = await createMint(
      connection,
      payer,
      payer.publicKey,
      null,
      pair.decimals,
    );
    collaterals[pair.id] = mint.toBase58();
  }

  const book = Keypair.generate();
  await airdrop(connection, book.publicKey, 10);
  const bookLoan = await createAssociatedTokenAccount(
    connection,
    payer,
    loanMint,
    book.publicKey,
  );
  await mintTo(
    connection,
    payer,
    loanMint,
    bookLoan,
    payer,
    10_000n * 1_000_000n,
  );

  const markets = [];
  for (const [tenorIndex, tenor] of TENORS.entries()) {
    const maturity = new BN(Math.floor(Date.parse(tenor.unix) / 1000));
    const tilt = tenorIndex === 2 ? -8 : tenorIndex === 1 ? -4 : 0;
    const rows = [
      { tick: 256 + tilt, units: 100 },
      { tick: 248 + tilt, units: 80 },
      { tick: 240 + tilt, units: 60 },
    ];
    for (const pair of PAIRS) {
      const keys = await createTestMarket(program, {
        maturity,
        minFill: MIN_FILL,
        collateralMint: new PublicKey(collaterals[pair.id]),
        loanMint,
        lltvBps: pair.lltvBps,
        priceE6: new BN(pair.mark * 1_000_000),
      });
      for (const [i, row] of rows.entries()) {
        await client.createQuote({
          maker: book.publicKey,
          market: keys.market,
          loanMint,
          makerLoan: bookLoan,
          seq: new BN(i + 1),
          tick: row.tick,
          units: FACE(row.units),
          signers: [book],
        });
      }
      markets.push({
        pair: pair.id,
        tenor: tenor.id,
        market: keys.market.toBase58(),
        loanVault: keys.loanVault.toBase58(),
        collateralVault: keys.collateralVault.toBase58(),
        curve: keys.curve.toBase58(),
        mockPrice: keys.mockPrice.toBase58(),
        collateralMint: keys.collateralMint.toBase58(),
        maturity: maturity.toNumber(),
        lltvBps: pair.lltvBps,
        collateralDecimals: pair.decimals,
        markE6: pair.mark * 1_000_000,
      });
      console.log(`Seeded ${pair.id} · ${tenor.id}`);
    }
  }

  const desk = {
    programId: program.programId.toBase58(),
    rpc: "http://127.0.0.1:8899",
    loanMint: loanMint.toBase58(),
    config: config.toBase58(),
    bookMaker: book.publicKey.toBase58(),
    pairs: PAIRS.map((pair) => ({
      id: pair.id,
      collateralMint: collaterals[pair.id],
      decimals: pair.decimals,
      faucet: pair.faucet,
    })),
    markets,
  };

  const out = resolve(__dirname, "../../frontend/public/local-desk.json");
  writeFileSync(out, `${JSON.stringify(desk, null, 2)}\n`);
  console.log(`Wrote ${out}`);
  console.log(`${markets.length} markets. Book maker funded with 10,000 USDC.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
