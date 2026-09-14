import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createMint,
  mintTo,
} from "@solana/spl-token";
import { Zorya } from "../target/types/zorya";
import {
  PRICE_E6,
  cancelQuote,
  createQuoteIx,
  createTestMarket,
  depositCollateral,
  fillQuote,
  liquidate,
  makeUser,
  nowPlusSecs,
  openFilledMarket,
  pda,
  redeem,
  repay,
  setPaused,
  waitUntilUnix,
  withdrawCollateral,
} from "./helpers";

/**
 * Named attacks from docs/04-security.md §3–§4.
 * Happy-path coverage lives in fill/collateral/redeem/liquidate.
 */
describe("attacks", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Zorya as Program<Zorya>;

  it("oracle wide conf: fill reverts when conf > 2%", async () => {
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

  it("fill oversized: take above the LLTV cap reverts Unhealthy", async () => {
    const fx = await createTestMarket(program);
    const lender = await makeUser(program, fx, { loan: 2_000_000_000n });
    const borrower = await makeUser(program, fx, { collateral: 1_000_000n });
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
      new BN(2_000_000_000),
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
        new BN(2_000_000_000),
      );
      expect.fail("oversized fill should fail");
    } catch (err) {
      expect(String(err)).to.match(/Unhealthy|custom program error/i);
    }
  });

  it("withdraw unhealthy: pulling most collateral after a fill reverts", async () => {
    const { fx, borrower } = await openFilledMarket(program);
    try {
      await withdrawCollateral(
        program,
        fx,
        borrower.user,
        borrower.collateralAta,
        new BN(9_900_000_000),
      );
      expect.fail("unhealthy withdraw should fail");
    } catch (err) {
      expect(String(err)).to.match(/Unhealthy|custom program error/i);
    }
  });

  it("redeem too early: before the calendar date reverts", async () => {
    const { fx, units, lender } = await openFilledMarket(program);
    try {
      await redeem(program, fx, lender.user, lender.loanAta, units);
      expect.fail("early redeem should fail");
    } catch (err) {
      expect(String(err)).to.match(/MarketNotMatured|custom program error/i);
    }
  });

  it("fill after maturity reverts", async () => {
    const fx = await createTestMarket(program, { maturity: nowPlusSecs(8) });
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
    await waitUntilUnix(provider.connection, fx.maturity.toNumber());
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
      expect.fail("fill after maturity should fail");
    } catch (err) {
      expect(String(err)).to.match(/MarketMatured|custom program error/i);
    }
  });

  it("pause matrix: create_quote blocked, repay and cancel still open", async () => {
    const { fx, units, borrower } = await openFilledMarket(program);
    const leftoverLender = await makeUser(program, fx, { loan: 200_000_000n });
    const leftover = await createQuoteIx(
      program,
      fx,
      leftoverLender.user,
      leftoverLender.loanAta,
      new BN(3),
      256,
      new BN(10_000_000),
    );
    await setPaused(program, true);
    try {
      const lender = await makeUser(program, fx, { loan: 200_000_000n });
      try {
        await createQuoteIx(
          program,
          fx,
          lender.user,
          lender.loanAta,
          new BN(9),
          256,
          new BN(10_000_000),
        );
        expect.fail("paused create_quote should fail");
      } catch (err) {
        expect(String(err)).to.match(/Paused|custom program error/i);
      }
      await repay(
        program,
        fx,
        borrower.user,
        borrower.loanAta,
        new BN(1_000_000),
      );
      const pos = await program.account.obligationPosition.fetch(
        pda(program.programId).obligation(fx.market, borrower.user.publicKey),
      );
      expect(pos.debtUnits.toString()).to.equal(
        units.sub(new BN(1_000_000)).toString(),
      );
      await cancelQuote(
        program,
        fx,
        leftoverLender.user,
        leftoverLender.loanAta,
        leftover.quote,
        leftover.quoteVault,
      );
    } finally {
      await setPaused(program, false);
    }
  });

  it("account substitution: quote from another market cannot fill", async () => {
    const a = await createTestMarket(program);
    const b = await createTestMarket(program);
    const lenderA = await makeUser(program, a, { loan: 200_000_000n });
    const borrowerB = await makeUser(program, b, {
      collateral: 10_000_000_000n,
    });
    await depositCollateral(
      program,
      b,
      borrowerB.user,
      borrowerB.collateralAta,
      new BN(10_000_000_000),
    );
    const { quote, quoteVault } = await createQuoteIx(
      program,
      a,
      lenderA.user,
      lenderA.loanAta,
      new BN(1),
      256,
      new BN(100_000_000),
    );
    try {
      await program.methods
        .fillQuote(new BN(100_000_000))
        .accountsPartial({
          taker: borrowerB.user.publicKey,
          config: b.config,
          market: b.market,
          collateralMint: b.collateralMint,
          quote,
          quoteVault,
          takerLoan: borrowerB.loanAta,
          makerLoan: lenderA.loanAta,
          claim: pda(program.programId).claim(b.market, lenderA.user.publicKey),
          obligation: pda(program.programId).obligation(
            b.market,
            borrowerB.user.publicKey,
          ),
          mockPrice: b.mockPrice,
          priceUpdate: b.mockPrice,
          curve: b.curve,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([borrowerB.user])
        .rpc();
      expect.fail("cross-market quote should fail");
    } catch (err) {
      expect(String(err)).to.match(
        /ConstraintSeeds|has_one|seeds|custom program error/i,
      );
    }
  });

  it("create_quote after maturity reverts", async () => {
    const fx = await createTestMarket(program, { maturity: nowPlusSecs(8) });
    const lender = await makeUser(program, fx, { loan: 200_000_000n });
    await waitUntilUnix(provider.connection, fx.maturity.toNumber());
    try {
      await createQuoteIx(
        program,
        fx,
        lender.user,
        lender.loanAta,
        new BN(1),
        256,
        new BN(100_000_000),
      );
      expect.fail("create_quote after maturity should fail");
    } catch (err) {
      expect(String(err)).to.match(/MarketMatured|custom program error/i);
    }
  });

  it("account substitution: cannot repay another owner's obligation", async () => {
    const { fx, borrower } = await openFilledMarket(program);
    const thief = await makeUser(program, fx, { loan: 200_000_000n });
    try {
      await program.methods
        .repay(new BN(1_000_000))
        .accountsPartial({
          owner: thief.user.publicKey,
          market: fx.market,
          obligation: pda(program.programId).obligation(
            fx.market,
            borrower.user.publicKey,
          ),
          ownerLoan: thief.loanAta,
          loanVault: fx.loanVault,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([thief.user])
        .rpc();
      expect.fail("foreign repay should fail");
    } catch (err) {
      expect(String(err)).to.match(
        /ConstraintSeeds|has_one|seeds|custom program error/i,
      );
    }
  });

  it("account substitution: cannot redeem another owner's claim", async () => {
    const { fx, units, lender } = await openFilledMarket(program, {
      maturity: nowPlusSecs(12),
    });
    await waitUntilUnix(provider.connection, fx.maturity.toNumber());
    const thief = await makeUser(program, fx, { loan: 1n });
    try {
      await program.methods
        .redeem(units)
        .accountsPartial({
          owner: thief.user.publicKey,
          market: fx.market,
          claim: pda(program.programId).claim(fx.market, lender.user.publicKey),
          ownerLoan: thief.loanAta,
          loanVault: fx.loanVault,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([thief.user])
        .rpc();
      expect.fail("foreign redeem should fail");
    } catch (err) {
      expect(String(err)).to.match(
        /ConstraintSeeds|has_one|seeds|custom program error/i,
      );
    }
  });

  it("fake loan mint on fill reverts", async () => {
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
      6,
    );
    const fakeLoan = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      fakeMint,
      borrower.user.publicKey,
    );
    await mintTo(
      provider.connection,
      payer,
      fakeMint,
      fakeLoan,
      payer,
      100_000_000n,
    );
    try {
      await program.methods
        .fillQuote(new BN(100_000_000))
        .accountsPartial({
          taker: borrower.user.publicKey,
          config: fx.config,
          market: fx.market,
          collateralMint: fx.collateralMint,
          quote,
          quoteVault,
          takerLoan: fakeLoan,
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
      expect.fail("fake loan mint should fail");
    } catch (err) {
      expect(String(err)).to.match(/MintMismatch|custom program error|constraint/i);
    }
  });

  it("self-liquidation is solvency-preserving", async () => {
    const { fx, units, borrower, lender } = await openFilledMarket(program);
    await program.methods
      .setMockPrice(new BN(13_000_000), new BN(0))
      .accountsPartial({
        authority: provider.publicKey,
        config: fx.config,
        market: fx.market,
        mockPrice: fx.mockPrice,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
    const repaid = new BN(10_000_000);
    const creditBefore = (
      await program.account.termMarket.fetch(fx.market)
    ).totalCreditUnits;
    await liquidate(
      program,
      fx,
      "health",
      borrower.user.publicKey,
      borrower.user,
      borrower.loanAta,
      borrower.collateralAta,
      repaid,
    );
    const market = await program.account.termMarket.fetch(fx.market);
    expect(market.totalCreditUnits.toString()).to.equal(creditBefore.toString());
    expect(market.totalDebtUnits.toString()).to.equal(
      units.sub(repaid).toString(),
    );
    const claim = await program.account.claimPosition.fetch(
      pda(program.programId).claim(fx.market, lender.user.publicKey),
    );
    expect(claim.creditUnits.toString()).to.equal(units.toString());
  });
});
