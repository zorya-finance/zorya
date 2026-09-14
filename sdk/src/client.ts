import { BN, Program } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, Signer, SystemProgram } from "@solana/web3.js";
import { Zorya } from "../../target/types/zorya";
import { readCurve, type CurveView } from "./curve";
import { findPdas } from "./pda";

export const DEFAULT_LLTV_BPS = 7000;
export const DEFAULT_LIQ_CURSOR_BPS = 3000;
export const DEFAULT_TICK_DELTA_BPS = 200;

export class ZoryaClient {
  readonly pdas: ReturnType<typeof findPdas>;

  constructor(readonly program: Program<Zorya>) {
    this.pdas = findPdas(program.programId);
  }

  async fetchCurve(
    collateralMint: PublicKey,
    loanMint: PublicKey,
  ): Promise<CurveView | null> {
    return readCurve(this.program, collateralMint, loanMint);
  }

  async initializeConfig(authority: PublicKey): Promise<PublicKey> {
    const config = this.pdas.config();
    await this.program.methods
      .initializeConfig()
      .accountsPartial({
        authority,
        config,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    return config;
  }

  async createMarket(args: {
    authority: PublicKey;
    collateralMint: PublicKey;
    loanMint: PublicKey;
    maturity: BN;
    lltvBps?: number;
    liquidationCursorBps?: number;
    tickDeltaBps?: number;
    minFillUnits: BN;
    oracleFeedId?: number[];
  }): Promise<{
    market: PublicKey;
    loanVault: PublicKey;
    collateralVault: PublicKey;
    curve: PublicKey;
    mockPrice: PublicKey;
  }> {
    const lltv = args.lltvBps ?? DEFAULT_LLTV_BPS;
    const market = this.pdas.market(
      args.collateralMint,
      args.loanMint,
      args.maturity,
      lltv,
    );
    const keys = {
      market,
      loanVault: this.pdas.loanVault(market),
      collateralVault: this.pdas.collateralVault(market),
      curve: this.pdas.curve(args.collateralMint, args.loanMint),
      mockPrice: this.pdas.mockPrice(market),
    };
    await this.program.methods
      .createMarket(
        args.maturity,
        lltv,
        args.liquidationCursorBps ?? DEFAULT_LIQ_CURSOR_BPS,
        args.tickDeltaBps ?? DEFAULT_TICK_DELTA_BPS,
        args.minFillUnits,
        args.oracleFeedId ?? Array.from(Buffer.alloc(32)),
      )
      .accountsPartial({
        authority: args.authority,
        config: this.pdas.config(),
        collateralMint: args.collateralMint,
        loanMint: args.loanMint,
        ...keys,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    return keys;
  }

  async depositCollateral(args: {
    owner: PublicKey;
    market: PublicKey;
    collateralMint: PublicKey;
    ownerCollateral: PublicKey;
    collateralVault: PublicKey;
    amount: BN;
    signers?: Signer[];
  }): Promise<PublicKey> {
    const obligation = this.pdas.obligation(args.market, args.owner);
    await this.program.methods
      .depositCollateral(args.amount)
      .accountsPartial({
        owner: args.owner,
        market: args.market,
        collateralMint: args.collateralMint,
        ownerCollateral: args.ownerCollateral,
        collateralVault: args.collateralVault,
        obligation,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers(args.signers ?? [])
      .rpc();
    return obligation;
  }

  async createQuote(args: {
    maker: PublicKey;
    payer?: PublicKey;
    market: PublicKey;
    loanMint: PublicKey;
    makerLoan: PublicKey;
    seq: BN;
    tick: number;
    units: BN;
    signers?: Signer[];
  }): Promise<{ quote: PublicKey; quoteVault: PublicKey }> {
    const quote = this.pdas.quote(args.market, args.maker, args.seq);
    const quoteVault = this.pdas.quoteVault(quote);
    await this.program.methods
      .createQuote(args.seq, args.tick, args.units)
      .accountsPartial({
        payer: args.payer ?? args.maker,
        maker: args.maker,
        config: this.pdas.config(),
        market: args.market,
        loanMint: args.loanMint,
        quote,
        quoteVault,
        makerLoan: args.makerLoan,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers(args.signers ?? [])
      .rpc();
    return { quote, quoteVault };
  }

  async fillQuote(args: {
    taker: PublicKey;
    market: PublicKey;
    collateralMint: PublicKey;
    quote: PublicKey;
    quoteVault: PublicKey;
    takerLoan: PublicKey;
    maker: PublicKey;
    makerLoan: PublicKey;
    mockPrice: PublicKey;
    /** Pyth `PriceUpdateV2`. Mock markets can pass `mockPrice`. */
    priceUpdate?: PublicKey;
    curve: PublicKey;
    maxUnits: BN;
    signers?: Signer[];
  }): Promise<void> {
    await this.program.methods
      .fillQuote(args.maxUnits)
      .accountsPartial({
        taker: args.taker,
        config: this.pdas.config(),
        market: args.market,
        collateralMint: args.collateralMint,
        quote: args.quote,
        quoteVault: args.quoteVault,
        takerLoan: args.takerLoan,
        makerLoan: args.makerLoan,
        claim: this.pdas.claim(args.market, args.maker),
        obligation: this.pdas.obligation(args.market, args.taker),
        mockPrice: args.mockPrice,
        priceUpdate: args.priceUpdate ?? args.mockPrice,
        curve: args.curve,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers(args.signers ?? [])
      .rpc();
  }

  async repay(args: {
    owner: PublicKey;
    market: PublicKey;
    ownerLoan: PublicKey;
    loanVault: PublicKey;
    units: BN;
    signers?: Signer[];
  }): Promise<void> {
    await this.program.methods
      .repay(args.units)
      .accountsPartial({
        owner: args.owner,
        market: args.market,
        obligation: this.pdas.obligation(args.market, args.owner),
        ownerLoan: args.ownerLoan,
        loanVault: args.loanVault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers(args.signers ?? [])
      .rpc();
  }

  async cancelQuote(args: {
    maker: PublicKey;
    market: PublicKey;
    quote: PublicKey;
    quoteVault: PublicKey;
    makerLoan: PublicKey;
    signers?: Signer[];
  }): Promise<void> {
    await this.program.methods
      .cancelQuote()
      .accountsPartial({
        maker: args.maker,
        market: args.market,
        quote: args.quote,
        quoteVault: args.quoteVault,
        makerLoan: args.makerLoan,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers(args.signers ?? [])
      .rpc();
  }

  async redeem(args: {
    owner: PublicKey;
    market: PublicKey;
    ownerLoan: PublicKey;
    loanVault: PublicKey;
    units: BN;
    signers?: Signer[];
  }): Promise<void> {
    await this.program.methods
      .redeem(args.units)
      .accountsPartial({
        owner: args.owner,
        market: args.market,
        claim: this.pdas.claim(args.market, args.owner),
        ownerLoan: args.ownerLoan,
        loanVault: args.loanVault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers(args.signers ?? [])
      .rpc();
  }

  async withdrawCollateral(args: {
    owner: PublicKey;
    market: PublicKey;
    collateralMint: PublicKey;
    ownerCollateral: PublicKey;
    collateralVault: PublicKey;
    mockPrice: PublicKey;
    priceUpdate?: PublicKey;
    amount: BN;
    signers?: Signer[];
  }): Promise<void> {
    await this.program.methods
      .withdrawCollateral(args.amount)
      .accountsPartial({
        owner: args.owner,
        config: this.pdas.config(),
        market: args.market,
        collateralMint: args.collateralMint,
        mockPrice: args.mockPrice,
        priceUpdate: args.priceUpdate ?? args.mockPrice,
        ownerCollateral: args.ownerCollateral,
        collateralVault: args.collateralVault,
        obligation: this.pdas.obligation(args.market, args.owner),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers(args.signers ?? [])
      .rpc();
  }

  async liquidate(args: {
    path: "health" | "default";
    liquidator: PublicKey;
    borrower: PublicKey;
    market: PublicKey;
    mockPrice: PublicKey;
    priceUpdate?: PublicKey;
    liquidatorLoan: PublicKey;
    liquidatorCollateral: PublicKey;
    loanVault: PublicKey;
    collateralVault: PublicKey;
    repaid: BN;
    signers?: Signer[];
  }): Promise<void> {
    const accounts = {
      liquidator: args.liquidator,
      borrower: args.borrower,
      market: args.market,
      obligation: this.pdas.obligation(args.market, args.borrower),
      mockPrice: args.mockPrice,
      priceUpdate: args.priceUpdate ?? args.mockPrice,
      liquidatorLoan: args.liquidatorLoan,
      liquidatorCollateral: args.liquidatorCollateral,
      loanVault: args.loanVault,
      collateralVault: args.collateralVault,
      tokenProgram: TOKEN_PROGRAM_ID,
    };
    const ix =
      args.path === "health"
        ? this.program.methods.liquidateHealth(args.repaid)
        : this.program.methods.liquidateDefault(args.repaid);
    await ix.accountsPartial(accounts).signers(args.signers ?? []).rpc();
  }
}
