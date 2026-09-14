import * as anchor from "@coral-xyz/anchor";
import { BN, EventParser, Program } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createMint,
  getAccount,
  mintTo,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SystemProgram,
} from "@solana/web3.js";
import { Zorya } from "../target/types/zorya";

export const LLTV_BPS = 7000;
export const LIQ_CURSOR_BPS = 3000;
export const TICK_DELTA_BPS = 200;
export const MIN_FILL = new BN(1_000_000);
export const PRICE_E6 = new BN(200_000_000);
export const COLLATERAL_DECIMALS = 9;
export const LOAN_DECIMALS = 6;
/** SOL/USD Pyth feed (`0xef0d8b6f…b56d`). */
export const SOL_USD_FEED_ID = [
  239, 13, 139, 111, 218, 44, 235, 164, 29, 161, 93, 64, 149, 209, 218, 57, 42,
  13, 47, 142, 208, 198, 199, 188, 15, 76, 250, 200, 194, 128, 181, 109,
];
export const PYTH_RECEIVER = new PublicKey(
  "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ",
);

export function nowPlusDays(days: number): BN {
  return new BN(Math.floor(Date.now() / 1000) + days * 24 * 3600);
}

export function nowPlusSecs(secs: number): BN {
  return new BN(Math.floor(Date.now() / 1000) + secs);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function validatorUnix(connection: Connection): Promise<number> {
  const info = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
  if (!info) {
    throw new Error("clock sysvar missing");
  }
  return Number(info.data.readBigInt64LE(32));
}

export async function parsedEvent(
  program: Program<Zorya>,
  sig: string,
  name: string,
): Promise<{ name: string; data: unknown } | undefined> {
  const parser = new EventParser(program.programId, program.coder);
  for (let i = 0; i < 15; i++) {
    const tx = await program.provider.connection.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const logs = tx?.meta?.logMessages ?? [];
    const events = [...parser.parseLogs(logs)];
    const ev = events.find(
      (e) => e.name.toLowerCase() === name.toLowerCase(),
    );
    if (ev) {
      return ev;
    }
    if (logs.some((l) => l.toLowerCase().includes(name.toLowerCase()))) {
      return { name, data: {} };
    }
    await sleep(200);
  }
  return undefined;
}

/** Wait until the validator Clock is strictly after `ts` (covers redeem and default liq). */
export async function waitUntilUnix(
  connection: Connection,
  ts: number,
): Promise<void> {
  for (;;) {
    const now = await validatorUnix(connection);
    if (now > ts) {
      return;
    }
    await sleep(400);
  }
}

function le(bn: BN, width: number): Buffer {
  return bn.toArrayLike(Buffer, "le", width);
}

export function pda(programId: PublicKey) {
  return {
    config: () =>
      PublicKey.findProgramAddressSync([Buffer.from("config")], programId)[0],
    market: (
      collateral: PublicKey,
      loan: PublicKey,
      maturity: BN,
      lltv: number,
    ) =>
      PublicKey.findProgramAddressSync(
        [
          Buffer.from("market"),
          collateral.toBuffer(),
          loan.toBuffer(),
          le(maturity, 8),
          le(new BN(lltv), 2),
        ],
        programId,
      )[0],
    loanVault: (market: PublicKey) =>
      PublicKey.findProgramAddressSync(
        [Buffer.from("loan-vault"), market.toBuffer()],
        programId,
      )[0],
    collateralVault: (market: PublicKey) =>
      PublicKey.findProgramAddressSync(
        [Buffer.from("collateral-vault"), market.toBuffer()],
        programId,
      )[0],
    curve: (collateral: PublicKey, loan: PublicKey) =>
      PublicKey.findProgramAddressSync(
        [Buffer.from("curve"), collateral.toBuffer(), loan.toBuffer()],
        programId,
      )[0],
    mockPrice: (market: PublicKey) =>
      PublicKey.findProgramAddressSync(
        [Buffer.from("mock-price"), market.toBuffer()],
        programId,
      )[0],
    claim: (market: PublicKey, owner: PublicKey) =>
      PublicKey.findProgramAddressSync(
        [Buffer.from("claim"), market.toBuffer(), owner.toBuffer()],
        programId,
      )[0],
    obligation: (market: PublicKey, owner: PublicKey) =>
      PublicKey.findProgramAddressSync(
        [Buffer.from("obligation"), market.toBuffer(), owner.toBuffer()],
        programId,
      )[0],
    quote: (market: PublicKey, maker: PublicKey, seq: BN) =>
      PublicKey.findProgramAddressSync(
        [
          Buffer.from("quote"),
          market.toBuffer(),
          maker.toBuffer(),
          le(seq, 8),
        ],
        programId,
      )[0],
    quoteVault: (quote: PublicKey) =>
      PublicKey.findProgramAddressSync(
        [Buffer.from("quote-vault"), quote.toBuffer()],
        programId,
      )[0],
  };
}

export async function airdrop(
  connection: Connection,
  to: PublicKey,
  sol = 10,
): Promise<void> {
  const sig = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, "confirmed");
}

export async function ensureConfig(program: Program<Zorya>): Promise<PublicKey> {
  const config = pda(program.programId).config();
  const info = await program.provider.connection.getAccountInfo(config);
  if (!info) {
    await program.methods
      .initializeConfig()
      .accountsPartial({
        authority: program.provider.publicKey!,
        config,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }
  return config;
}

export async function setPaused(
  program: Program<Zorya>,
  paused: boolean,
): Promise<void> {
  const config = pda(program.programId).config();
  await program.methods
    .setPaused(paused)
    .accountsPartial({
      authority: program.provider.publicKey!,
      config,
    })
    .rpc();
}

export interface MarketFx {
  collateralMint: PublicKey;
  loanMint: PublicKey;
  market: PublicKey;
  loanVault: PublicKey;
  collateralVault: PublicKey;
  curve: PublicKey;
  mockPrice: PublicKey;
  maturity: BN;
  config: PublicKey;
}

export async function createTestMints(
  program: Program<Zorya>,
): Promise<{ collateralMint: PublicKey; loanMint: PublicKey }> {
  const payer = (program.provider as anchor.AnchorProvider).wallet
    .payer as Keypair;
  const connection = program.provider.connection;
  const collateralMint = await createMint(
    connection,
    payer,
    payer.publicKey,
    null,
    COLLATERAL_DECIMALS,
  );
  const loanMint = await createMint(
    connection,
    payer,
    payer.publicKey,
    null,
    LOAN_DECIMALS,
  );
  return { collateralMint, loanMint };
}

export async function createTestMarket(
  program: Program<Zorya>,
  opts?: {
    maturity?: BN;
    minFill?: BN;
    collateralMint?: PublicKey;
    loanMint?: PublicKey;
    lltvBps?: number;
    priceE6?: BN;
    setPrice?: boolean;
    oracleFeedId?: number[];
  },
): Promise<MarketFx> {
  const config = await ensureConfig(program);
  const minted =
    opts?.collateralMint && opts?.loanMint
      ? { collateralMint: opts.collateralMint, loanMint: opts.loanMint }
      : await createTestMints(program);
  const { collateralMint, loanMint } = minted;
  const maturity = opts?.maturity ?? nowPlusDays(60);
  const minFill = opts?.minFill ?? MIN_FILL;
  const lltvBps = opts?.lltvBps ?? LLTV_BPS;
  const oracleFeedId = opts?.oracleFeedId ?? Array.from(Buffer.alloc(32));
  const isPyth = oracleFeedId.some((b) => b !== 0);
  const keys = pda(program.programId);
  const market = keys.market(collateralMint, loanMint, maturity, lltvBps);
  const loanVault = keys.loanVault(market);
  const collateralVault = keys.collateralVault(market);
  const curve = keys.curve(collateralMint, loanMint);
  const mockPrice = keys.mockPrice(market);

  await program.methods
    .createMarket(
      maturity,
      lltvBps,
      LIQ_CURSOR_BPS,
      TICK_DELTA_BPS,
      minFill,
      oracleFeedId,
    )
    .accountsPartial({
      authority: program.provider.publicKey!,
      config,
      collateralMint,
      loanMint,
      market,
      loanVault,
      collateralVault,
      curve,
      mockPrice,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  if (opts?.setPrice !== false && !isPyth) {
    await program.methods
      .setMockPrice(opts?.priceE6 ?? PRICE_E6, new BN(0))
      .accountsPartial({
        authority: program.provider.publicKey!,
        config,
        market,
        mockPrice,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  return {
    collateralMint,
    loanMint,
    market,
    loanVault,
    collateralVault,
    curve,
    mockPrice,
    maturity,
    config,
  };
}

export async function makeUser(
  program: Program<Zorya>,
  fx: MarketFx,
  opts?: { collateral?: bigint; loan?: bigint },
): Promise<{
  user: Keypair;
  collateralAta: PublicKey;
  loanAta: PublicKey;
}> {
  const payer = (program.provider as anchor.AnchorProvider).wallet
    .payer as Keypair;
  const connection = program.provider.connection;
  const user = Keypair.generate();
  await airdrop(connection, user.publicKey);
  const collateralAta = await createAssociatedTokenAccount(
    connection,
    payer,
    fx.collateralMint,
    user.publicKey,
  );
  const loanAta = await createAssociatedTokenAccount(
    connection,
    payer,
    fx.loanMint,
    user.publicKey,
  );
  if (opts?.collateral && opts.collateral > 0n) {
    await mintTo(
      connection,
      payer,
      fx.collateralMint,
      collateralAta,
      payer,
      opts.collateral,
    );
  }
  if (opts?.loan && opts.loan > 0n) {
    await mintTo(connection, payer, fx.loanMint, loanAta, payer, opts.loan);
  }
  return { user, collateralAta, loanAta };
}

export async function depositCollateral(
  program: Program<Zorya>,
  fx: MarketFx,
  owner: Keypair,
  ownerCollateral: PublicKey,
  amount: BN,
): Promise<PublicKey> {
  const obligation = pda(program.programId).obligation(
    fx.market,
    owner.publicKey,
  );
  await program.methods
    .depositCollateral(amount)
    .accountsPartial({
      owner: owner.publicKey,
      market: fx.market,
      collateralMint: fx.collateralMint,
      ownerCollateral,
      collateralVault: fx.collateralVault,
      obligation,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([owner])
    .rpc();
  return obligation;
}

export async function createQuoteIx(
  program: Program<Zorya>,
  fx: MarketFx,
  maker: Keypair,
  makerLoan: PublicKey,
  seq: BN,
  tick: number,
  units: BN,
): Promise<{ quote: PublicKey; quoteVault: PublicKey }> {
  const keys = pda(program.programId);
  const quote = keys.quote(fx.market, maker.publicKey, seq);
  const quoteVault = keys.quoteVault(quote);
  await program.methods
    .createQuote(seq, tick, units)
    .accountsPartial({
      maker: maker.publicKey,
      config: fx.config,
      market: fx.market,
      loanMint: fx.loanMint,
      quote,
      quoteVault,
      makerLoan,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([maker])
    .rpc();
  return { quote, quoteVault };
}

export async function tokenBalance(
  connection: Connection,
  ata: PublicKey,
): Promise<bigint> {
  return (await getAccount(connection, ata)).amount;
}

export async function fillQuote(
  program: Program<Zorya>,
  fx: MarketFx,
  quote: PublicKey,
  quoteVault: PublicKey,
  taker: Keypair,
  takerLoan: PublicKey,
  maker: PublicKey,
  makerLoan: PublicKey,
  maxUnits: BN,
): Promise<void> {
  await program.methods
    .fillQuote(maxUnits)
    .accountsPartial({
      taker: taker.publicKey,
      config: fx.config,
      market: fx.market,
      collateralMint: fx.collateralMint,
      quote,
      quoteVault,
      takerLoan,
      makerLoan,
      claim: pda(program.programId).claim(fx.market, maker),
      obligation: pda(program.programId).obligation(fx.market, taker.publicKey),
      mockPrice: fx.mockPrice,
      priceUpdate: fx.mockPrice,
      curve: fx.curve,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([taker])
    .rpc();
}

export async function redeem(
  program: Program<Zorya>,
  fx: MarketFx,
  owner: Keypair,
  ownerLoan: PublicKey,
  units: BN,
): Promise<string> {
  return program.methods
    .redeem(units)
    .accountsPartial({
      owner: owner.publicKey,
      market: fx.market,
      claim: pda(program.programId).claim(fx.market, owner.publicKey),
      ownerLoan,
      loanVault: fx.loanVault,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([owner])
    .rpc();
}

export async function liquidate(
  program: Program<Zorya>,
  fx: MarketFx,
  path: "health" | "default",
  borrower: PublicKey,
  liquidator: Keypair,
  liquidatorLoan: PublicKey,
  liquidatorCollateral: PublicKey,
  repaid: BN,
): Promise<string> {
  const accounts = {
    liquidator: liquidator.publicKey,
    borrower,
    market: fx.market,
    obligation: pda(program.programId).obligation(fx.market, borrower),
    mockPrice: fx.mockPrice,
    priceUpdate: fx.mockPrice,
    liquidatorLoan,
    liquidatorCollateral,
    loanVault: fx.loanVault,
    collateralVault: fx.collateralVault,
    tokenProgram: TOKEN_PROGRAM_ID,
  };
  const ix =
    path === "health"
      ? program.methods.liquidateHealth(repaid)
      : program.methods.liquidateDefault(repaid);
  return ix.accountsPartial(accounts).signers([liquidator]).rpc();
}

export async function openFilledMarket(
  program: Program<Zorya>,
  opts?: { maturity?: BN; units?: BN; collateral?: bigint },
): Promise<{
  fx: MarketFx;
  units: BN;
  lender: Awaited<ReturnType<typeof makeUser>>;
  borrower: Awaited<ReturnType<typeof makeUser>>;
  obligation: PublicKey;
}> {
  const fx = await createTestMarket(program, { maturity: opts?.maturity });
  const units = opts?.units ?? new BN(100_000_000);
  const lender = await makeUser(program, fx, { loan: 200_000_000n });
  const borrower = await makeUser(program, fx, {
    collateral: opts?.collateral ?? 10_000_000_000n,
    loan: 200_000_000n,
  });
  const obligation = await depositCollateral(
    program,
    fx,
    borrower.user,
    borrower.collateralAta,
    new BN((opts?.collateral ?? 10_000_000_000n).toString()),
  );
  const { quote, quoteVault } = await createQuoteIx(
    program,
    fx,
    lender.user,
    lender.loanAta,
    new BN(1),
    256,
    units,
  );
  await fillQuote(
    program,
    fx,
    quote,
    quoteVault,
    borrower.user,
    borrower.loanAta,
    lender.user.publicKey,
    lender.loanAta,
    units,
  );
  return { fx, units, lender, borrower, obligation };
}
