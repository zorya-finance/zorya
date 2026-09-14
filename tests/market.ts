import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { SystemProgram } from "@solana/web3.js";
import { Zorya } from "../target/types/zorya";
import {
  LLTV_BPS,
  LIQ_CURSOR_BPS,
  TICK_DELTA_BPS,
  MIN_FILL,
  createTestMarket,
  createTestMints,
  ensureConfig,
  nowPlusDays,
  pda,
  setPaused,
} from "./helpers";

describe("market", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Zorya as Program<Zorya>;

  it("creates an immutable market with vaults", async () => {
    const fx = await createTestMarket(program);
    const market = await program.account.termMarket.fetch(fx.market);
    expect(market.collateralMint.toBase58()).to.equal(
      fx.collateralMint.toBase58(),
    );
    expect(market.loanMint.toBase58()).to.equal(fx.loanMint.toBase58());
    expect(market.lltvBps).to.equal(LLTV_BPS);
    expect(market.liquidationCursorBps).to.equal(LIQ_CURSOR_BPS);
    expect(market.tickDeltaBps).to.equal(TICK_DELTA_BPS);
    expect(market.minFillUnits.toNumber()).to.equal(MIN_FILL.toNumber());
    expect(market.totalCreditUnits.toNumber()).to.equal(0);
    expect(market.totalDebtUnits.toNumber()).to.equal(0);
    expect(market.oracleKind).to.equal(0);
    expect(market.collateralDecimals).to.equal(9);
    expect(market.loanDecimals).to.equal(6);

    const loanVault = await provider.connection.getTokenAccountBalance(
      fx.loanVault,
    );
    const collVault = await provider.connection.getTokenAccountBalance(
      fx.collateralVault,
    );
    expect(loanVault.value.amount).to.equal("0");
    expect(collVault.value.amount).to.equal("0");
  });

  it("rejects a second create with the same params", async () => {
    const fx = await createTestMarket(program);
    try {
      await program.methods
        .createMarket(
          fx.maturity,
          LLTV_BPS,
          LIQ_CURSOR_BPS,
          TICK_DELTA_BPS,
          MIN_FILL,
          Array.from(Buffer.alloc(32)),
        )
        .accountsPartial({
          authority: provider.publicKey,
          config: fx.config,
          collateralMint: fx.collateralMint,
          loanMint: fx.loanMint,
          market: fx.market,
          loanVault: fx.loanVault,
          collateralVault: fx.collateralVault,
          curve: fx.curve,
          mockPrice: fx.mockPrice,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      expect.fail("double create should fail");
    } catch (err) {
      expect(String(err)).to.match(/already in use/i);
    }
  });

  it("rejects identical collateral and loan mints", async () => {
    const config = await ensureConfig(program);
    const { collateralMint } = await createTestMints(program);
    const maturity = nowPlusDays(60);
    const keys = pda(program.programId);
    const market = keys.market(collateralMint, collateralMint, maturity, LLTV_BPS);
    try {
      await program.methods
        .createMarket(
          maturity,
          LLTV_BPS,
          LIQ_CURSOR_BPS,
          TICK_DELTA_BPS,
          MIN_FILL,
          Array.from(Buffer.alloc(32)),
        )
        .accountsPartial({
          authority: provider.publicKey,
          config,
          collateralMint,
          loanMint: collateralMint,
          market,
          loanVault: keys.loanVault(market),
          collateralVault: keys.collateralVault(market),
          curve: keys.curve(collateralMint, collateralMint),
          mockPrice: keys.mockPrice(market),
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      expect.fail("same mints should fail");
    } catch (err) {
      expect(String(err)).to.match(/MintsMustDiffer|custom program error/i);
    }
  });

  it("rejects a maturity outside the allowed window", async () => {
    const config = await ensureConfig(program);
    const { collateralMint, loanMint } = await createTestMints(program);
    const maturity = nowPlusDays(600);
    const keys = pda(program.programId);
    const market = keys.market(collateralMint, loanMint, maturity, LLTV_BPS);
    try {
      await program.methods
        .createMarket(
          maturity,
          LLTV_BPS,
          LIQ_CURSOR_BPS,
          TICK_DELTA_BPS,
          MIN_FILL,
          Array.from(Buffer.alloc(32)),
        )
        .accountsPartial({
          authority: provider.publicKey,
          config,
          collateralMint,
          loanMint,
          market,
          loanVault: keys.loanVault(market),
          collateralVault: keys.collateralVault(market),
          curve: keys.curve(collateralMint, loanMint),
          mockPrice: keys.mockPrice(market),
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      expect.fail("short maturity should fail");
    } catch (err) {
      expect(String(err)).to.match(/InvalidMaturity|custom program error/i);
    }
  });

  it("rejects an LLTV that is not allowlisted", async () => {
    const config = await ensureConfig(program);
    const { collateralMint, loanMint } = await createTestMints(program);
    const maturity = nowPlusDays(60);
    const keys = pda(program.programId);
    const market = keys.market(collateralMint, loanMint, maturity, 5000);
    try {
      await program.methods
        .createMarket(
          maturity,
          5000,
          LIQ_CURSOR_BPS,
          TICK_DELTA_BPS,
          MIN_FILL,
          Array.from(Buffer.alloc(32)),
        )
        .accountsPartial({
          authority: provider.publicKey,
          config,
          collateralMint,
          loanMint,
          market,
          loanVault: keys.loanVault(market),
          collateralVault: keys.collateralVault(market),
          curve: keys.curve(collateralMint, loanMint),
          mockPrice: keys.mockPrice(market),
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      expect.fail("bad lltv should fail");
    } catch (err) {
      expect(String(err)).to.match(/LltvNotAllowed|custom program error/i);
    }
  });

  it("appends a second tenor on the same curve account", async () => {
    const first = await createTestMarket(program, { maturity: nowPlusDays(60) });
    const second = await createTestMarket(program, {
      collateralMint: first.collateralMint,
      loanMint: first.loanMint,
      maturity: nowPlusDays(90),
    });
    expect(second.curve.toBase58()).to.equal(first.curve.toBase58());
    const curve = await program.account.curve.fetch(first.curve);
    expect(curve.tenorCount).to.equal(2);
    expect(curve.maturityTs[0].toString()).to.equal(first.maturity.toString());
    expect(curve.maturityTs[1].toString()).to.equal(second.maturity.toString());
  });

  it("blocks create_market while paused", async () => {
    await setPaused(program, true);
    try {
      await createTestMarket(program);
      expect.fail("paused create_market should fail");
    } catch (err) {
      expect(String(err)).to.match(/Paused|custom program error/i);
    } finally {
      await setPaused(program, false);
    }
  });
});
