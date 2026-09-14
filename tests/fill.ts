import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import { TOKEN_PROGRAM_ID, createMint } from "@solana/spl-token";
import { Zorya } from "../target/types/zorya";
import {
  PRICE_E6,
  createQuoteIx,
  createTestMarket,
  depositCollateral,
  fillQuote,
  makeUser,
  pda,
  setPaused,
  tokenBalance,
} from "./helpers";

describe("fill", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Zorya as Program<Zorya>;

  it("fills a quote, mints claim/obligation, and pays the borrower", async () => {
    const fx = await createTestMarket(program);
    const units = new BN(100_000_000);
    const lender = await makeUser(program, fx, { loan: 200_000_000n });
    const borrower = await makeUser(program, fx, {
      collateral: 10_000_000_000n,
    });
    await depositCollateral(
      program,
      fx,
      borrower.user,
      borrower.collateralAta,
      new BN(10_000_000_000),
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

    const beforeLoan = await tokenBalance(
      provider.connection,
      borrower.loanAta,
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

    expect(
      await tokenBalance(provider.connection, borrower.loanAta),
    ).to.equal(beforeLoan + 50_000_000n);

    const market = await program.account.termMarket.fetch(fx.market);
    expect(market.totalCreditUnits.toString()).to.equal(units.toString());
    expect(market.totalDebtUnits.toString()).to.equal(units.toString());

    const claim = await program.account.claimPosition.fetch(
      pda(program.programId).claim(fx.market, lender.user.publicKey),
    );
    expect(claim.creditUnits.toString()).to.equal(units.toString());

    const obligation = await program.account.obligationPosition.fetch(
      pda(program.programId).obligation(fx.market, borrower.user.publicKey),
    );
    expect(obligation.debtUnits.toString()).to.equal(units.toString());

    const curve = await program.account.curve.fetch(fx.curve);
    expect(curve.cumulativeUnits[0].toString()).to.equal(units.toString());
    expect(curve.lastPriceWad[0].toString()).to.equal(
      "500000000000000000",
    );
  });

  it("reverts an unhealthy fill", async () => {
    const fx = await createTestMarket(program);
    const units = new BN(2_000_000_000);
    const lender = await makeUser(program, fx, { loan: 2_000_000_000n });
    const borrower = await makeUser(program, fx, {
      collateral: 1_000_000n,
    });
    await depositCollateral(
      program,
      fx,
      borrower.user,
      borrower.collateralAta,
      new BN(1_000_000),
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
    try {
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
      expect.fail("unhealthy fill should fail");
    } catch (err) {
      expect(String(err)).to.match(/Unhealthy|custom program error/i);
    }
  });

  it("rejects an invalid tick at quote creation", async () => {
    const fx = await createTestMarket(program);
    const lender = await makeUser(program, fx, { loan: 200_000_000n });
    try {
      await createQuoteIx(
        program,
        fx,
        lender.user,
        lender.loanAta,
        new BN(9),
        9_999,
        new BN(100_000_000),
      );
      expect.fail("invalid tick should fail");
    } catch (err) {
      expect(String(err)).to.match(/InvalidTick|custom program error/i);
    }
  });

  it("blocks fill while paused", async () => {
    const fx = await createTestMarket(program);
    const lender = await makeUser(program, fx, { loan: 200_000_000n });
    const borrower = await makeUser(program, fx, {
      collateral: 10_000_000_000n,
    });
    await depositCollateral(
      program,
      fx,
      borrower.user,
      borrower.collateralAta,
      new BN(10_000_000_000),
    );
    const { quote, quoteVault } = await createQuoteIx(
      program,
      fx,
      lender.user,
      lender.loanAta,
      new BN(1),
      256,
      new BN(100_000_000),
    );
    await setPaused(program, true);
    try {
      await fillQuote(
        program,
        fx,
        quote,
        quoteVault,
        borrower.user,
        borrower.loanAta,
        lender.user.publicKey,
        lender.loanAta,
        new BN(100_000_000),
      );
      expect.fail("paused fill should fail");
    } catch (err) {
      expect(String(err)).to.match(/Paused|custom program error/i);
    } finally {
      await setPaused(program, false);
    }
  });

  it("allows a partial fill and keeps leftover escrow", async () => {
    const fx = await createTestMarket(program);
    const lender = await makeUser(program, fx, { loan: 200_000_000n });
    const borrower = await makeUser(program, fx, {
      collateral: 10_000_000_000n,
    });
    await depositCollateral(
      program,
      fx,
      borrower.user,
      borrower.collateralAta,
      new BN(10_000_000_000),
    );
    const { quote, quoteVault } = await createQuoteIx(
      program,
      fx,
      lender.user,
      lender.loanAta,
      new BN(1),
      256,
      new BN(100_000_000),
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
      new BN(40_000_000),
    );
    const q = await program.account.quote.fetch(quote);
    expect(q.remainingUnits.toString()).to.equal("60000000");
    expect(q.escrowedLoan.toString()).to.equal("30000000");
    expect(await tokenBalance(provider.connection, quoteVault)).to.equal(
      30_000_000n,
    );
  });

  it("closes dust remainder and refunds leftover escrow", async () => {
    const fx = await createTestMarket(program);
    const lender = await makeUser(program, fx, { loan: 2_000_000n });
    const borrower = await makeUser(program, fx, {
      collateral: 10_000_000_000n,
    });
    await depositCollateral(
      program,
      fx,
      borrower.user,
      borrower.collateralAta,
      new BN(10_000_000_000),
    );
    const beforeMaker = await tokenBalance(provider.connection, lender.loanAta);
    const { quote, quoteVault } = await createQuoteIx(
      program,
      fx,
      lender.user,
      lender.loanAta,
      new BN(1),
      256,
      new BN(1_500_000),
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
      new BN(1_000_000),
    );
    const q = await program.account.quote.fetch(quote);
    expect(q.remainingUnits.toNumber()).to.equal(0);
    expect(q.escrowedLoan.toNumber()).to.equal(0);
    expect(await tokenBalance(provider.connection, quoteVault)).to.equal(0n);
    expect(await tokenBalance(provider.connection, lender.loanAta)).to.equal(
      beforeMaker - 500_000n,
    );
  });

  it("rejects a self-fill", async () => {
    const fx = await createTestMarket(program);
    const user = await makeUser(program, fx, {
      collateral: 10_000_000_000n,
      loan: 200_000_000n,
    });
    await depositCollateral(
      program,
      fx,
      user.user,
      user.collateralAta,
      new BN(10_000_000_000),
    );
    const { quote, quoteVault } = await createQuoteIx(
      program,
      fx,
      user.user,
      user.loanAta,
      new BN(1),
      256,
      new BN(100_000_000),
    );
    try {
      await fillQuote(
        program,
        fx,
        quote,
        quoteVault,
        user.user,
        user.loanAta,
        user.user.publicKey,
        user.loanAta,
        new BN(100_000_000),
      );
      expect.fail("self-fill should fail");
    } catch (err) {
      expect(String(err)).to.match(/SelfTrade|custom program error/i);
    }
  });

  it("rejects a fill below min_fill that does not empty the quote", async () => {
    const fx = await createTestMarket(program);
    const lender = await makeUser(program, fx, { loan: 200_000_000n });
    const borrower = await makeUser(program, fx, {
      collateral: 10_000_000_000n,
    });
    await depositCollateral(
      program,
      fx,
      borrower.user,
      borrower.collateralAta,
      new BN(10_000_000_000),
    );
    const { quote, quoteVault } = await createQuoteIx(
      program,
      fx,
      lender.user,
      lender.loanAta,
      new BN(1),
      256,
      new BN(100_000_000),
    );
    try {
      await fillQuote(
        program,
        fx,
        quote,
        quoteVault,
        borrower.user,
        borrower.loanAta,
        lender.user.publicKey,
        lender.loanAta,
        new BN(1),
      );
      expect.fail("tiny fill should fail");
    } catch (err) {
      expect(String(err)).to.match(/FillTooSmall|custom program error/i);
    }
  });

  it("rejects a fill when oracle confidence is too wide", async () => {
    const fx = await createTestMarket(program);
    await program.methods
      .setMockPrice(PRICE_E6, new BN(5_000_000))
      .accountsPartial({
        authority: provider.publicKey,
        config: fx.config,
        market: fx.market,
        mockPrice: fx.mockPrice,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
    const lender = await makeUser(program, fx, { loan: 200_000_000n });
    const borrower = await makeUser(program, fx, {
      collateral: 10_000_000_000n,
    });
    await depositCollateral(
      program,
      fx,
      borrower.user,
      borrower.collateralAta,
      new BN(10_000_000_000),
    );
    const { quote, quoteVault } = await createQuoteIx(
      program,
      fx,
      lender.user,
      lender.loanAta,
      new BN(1),
      256,
      new BN(100_000_000),
    );
    try {
      await fillQuote(
        program,
        fx,
        quote,
        quoteVault,
        borrower.user,
        borrower.loanAta,
        lender.user.publicKey,
        lender.loanAta,
        new BN(100_000_000),
      );
      expect.fail("wide confidence should fail");
    } catch (err) {
      expect(String(err)).to.match(
        /OracleConfidenceTooWide|custom program error/i,
      );
    }
  });

  it("rejects a fill with a substituted collateral mint", async () => {
    const fx = await createTestMarket(program);
    const lender = await makeUser(program, fx, { loan: 200_000_000n });
    const borrower = await makeUser(program, fx, {
      collateral: 10_000_000_000n,
    });
    await depositCollateral(
      program,
      fx,
      borrower.user,
      borrower.collateralAta,
      new BN(10_000_000_000),
    );
    const { quote, quoteVault } = await createQuoteIx(
      program,
      fx,
      lender.user,
      lender.loanAta,
      new BN(1),
      256,
      new BN(100_000_000),
    );
    const payer = (provider.wallet as anchor.Wallet).payer;
    const fakeMint = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      null,
      0,
    );
    try {
      await program.methods
        .fillQuote(new BN(100_000_000))
        .accountsPartial({
          taker: borrower.user.publicKey,
          config: fx.config,
          market: fx.market,
          collateralMint: fakeMint,
          quote,
          quoteVault,
          takerLoan: borrower.loanAta,
          makerLoan: lender.loanAta,
          claim: pda(program.programId).claim(fx.market, lender.user.publicKey),
          obligation: pda(program.programId).obligation(
            fx.market,
            borrower.user.publicKey,
          ),
          mockPrice: fx.mockPrice,
          priceUpdate: fx.mockPrice,
          curve: fx.curve,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([borrower.user])
        .rpc();
      expect.fail("mint substitution should fail");
    } catch (err) {
      expect(String(err)).to.match(/MintMismatch|custom program error|constraint/i);
    }
  });
});
