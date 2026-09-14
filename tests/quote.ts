import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair } from "@solana/web3.js";
import { Zorya } from "../target/types/zorya";
import {
  createQuoteIx,
  createTestMarket,
  depositCollateral,
  fillQuote,
  makeUser,
  pda,
  setPaused,
  tokenBalance,
} from "./helpers";

describe("quote", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Zorya as Program<Zorya>;

  it("escrows loan atoms and returns them on cancel", async () => {
    const fx = await createTestMarket(program);
    const units = new BN(100_000_000);
    const { user, loanAta } = await makeUser(program, fx, {
      loan: 200_000_000n,
    });
    const before = await tokenBalance(provider.connection, loanAta);
    const { quote, quoteVault } = await createQuoteIx(
      program,
      fx,
      user,
      loanAta,
      new BN(1),
      256,
      units,
    );

    const q = await program.account.quote.fetch(quote);
    expect(q.tick).to.equal(256);
    expect(q.remainingUnits.toString()).to.equal(units.toString());
    expect(q.escrowedLoan.toString()).to.equal("50000000");
    expect(await tokenBalance(provider.connection, quoteVault)).to.equal(
      50_000_000n,
    );
    expect(await tokenBalance(provider.connection, loanAta)).to.equal(
      before - 50_000_000n,
    );

    await program.methods
      .cancelQuote()
      .accountsPartial({
        maker: user.publicKey,
        market: fx.market,
        quote,
        quoteVault,
        makerLoan: loanAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();

    expect(await tokenBalance(provider.connection, loanAta)).to.equal(before);
    expect(await provider.connection.getAccountInfo(quote)).to.equal(null);
  });

  it("rejects cancel from a non-maker", async () => {
    const fx = await createTestMarket(program);
    const { user, loanAta } = await makeUser(program, fx, {
      loan: 200_000_000n,
    });
    const { quote, quoteVault } = await createQuoteIx(
      program,
      fx,
      user,
      loanAta,
      new BN(2),
      256,
      new BN(100_000_000),
    );
    const stranger = Keypair.generate();
    try {
      await program.methods
        .cancelQuote()
        .accountsPartial({
          maker: stranger.publicKey,
          market: fx.market,
          quote,
          quoteVault,
          makerLoan: loanAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([stranger])
        .rpc();
      expect.fail("non-maker cancel should fail");
    } catch (err) {
      expect(String(err)).to.match(
        /ConstraintHasOne|ConstraintSeeds|custom program error|has one/i,
      );
    }
  });

  it("blocks create_quote while paused and still allows cancel", async () => {
    const fx = await createTestMarket(program);
    const { user, loanAta } = await makeUser(program, fx, {
      loan: 200_000_000n,
    });
    const { quote, quoteVault } = await createQuoteIx(
      program,
      fx,
      user,
      loanAta,
      new BN(3),
      256,
      new BN(100_000_000),
    );
    await setPaused(program, true);
    try {
      await createQuoteIx(
        program,
        fx,
        user,
        loanAta,
        new BN(4),
        256,
        new BN(100_000_000),
      );
      expect.fail("paused create should fail");
    } catch (err) {
      expect(String(err)).to.match(/Paused|custom program error/i);
    }

    await program.methods
      .cancelQuote()
      .accountsPartial({
        maker: user.publicKey,
        market: fx.market,
        quote,
        quoteVault,
        makerLoan: loanAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();
    await setPaused(program, false);
  });

  it("returns leftover escrow after a partial fill", async () => {
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
    const before = await tokenBalance(provider.connection, lender.loanAta);
    await program.methods
      .cancelQuote()
      .accountsPartial({
        maker: lender.user.publicKey,
        market: fx.market,
        quote,
        quoteVault,
        makerLoan: lender.loanAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([lender.user])
      .rpc();
    expect(await tokenBalance(provider.connection, lender.loanAta)).to.equal(
      before + 30_000_000n,
    );
    expect(await provider.connection.getAccountInfo(quote)).to.equal(null);
  });
});
