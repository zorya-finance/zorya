import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import { TOKEN_PROGRAM_ID, mintTo } from "@solana/spl-token";
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

describe("repay", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Zorya as Program<Zorya>;
  const payer = (provider.wallet as anchor.Wallet).payer;

  async function openPosition() {
    const fx = await createTestMarket(program);
    const units = new BN(100_000_000);
    const lender = await makeUser(program, fx, { loan: 200_000_000n });
    const borrower = await makeUser(program, fx, {
      collateral: 10_000_000_000n,
      loan: 200_000_000n,
    });
    const obligation = await depositCollateral(
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
    return { fx, units, borrower, obligation, lender };
  }

  it("repays a partial then the remainder", async () => {
    const { fx, units, borrower, obligation } = await openPosition();
    const half = new BN(40_000_000);
    await program.methods
      .repay(half)
      .accountsPartial({
        owner: borrower.user.publicKey,
        market: fx.market,
        obligation,
        ownerLoan: borrower.loanAta,
        loanVault: fx.loanVault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([borrower.user])
      .rpc();

    expect(
      (await program.account.obligationPosition.fetch(obligation)).debtUnits.toString(),
    ).to.equal("60000000");
    expect(
      (await program.account.termMarket.fetch(fx.market)).totalDebtUnits.toString(),
    ).to.equal("60000000");
    expect(await tokenBalance(provider.connection, fx.loanVault)).to.equal(
      40_000_000n,
    );

    await program.methods
      .repay(new BN(60_000_000))
      .accountsPartial({
        owner: borrower.user.publicKey,
        market: fx.market,
        obligation,
        ownerLoan: borrower.loanAta,
        loanVault: fx.loanVault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([borrower.user])
      .rpc();

    expect(
      (await program.account.obligationPosition.fetch(obligation)).debtUnits.toNumber(),
    ).to.equal(0);
    expect(
      (await program.account.termMarket.fetch(fx.market)).totalDebtUnits.toNumber(),
    ).to.equal(0);
    expect(await tokenBalance(provider.connection, fx.loanVault)).to.equal(
      100_000_000n,
    );
  });

  it("rejects a repay larger than remaining debt", async () => {
    const { fx, borrower, obligation } = await openPosition();
    try {
      await program.methods
        .repay(new BN(100_000_001))
        .accountsPartial({
          owner: borrower.user.publicKey,
          market: fx.market,
          obligation,
          ownerLoan: borrower.loanAta,
          loanVault: fx.loanVault,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([borrower.user])
        .rpc();
      expect.fail("over-repay should fail");
    } catch (err) {
      expect(String(err)).to.match(/InsufficientDebt|custom program error/i);
    }
  });

  it("rejects a second full repay", async () => {
    const { fx, units, borrower, obligation } = await openPosition();
    await mintTo(
      provider.connection,
      payer,
      fx.loanMint,
      borrower.loanAta,
      payer,
      100_000_000n,
    );
    await program.methods
      .repay(units)
      .accountsPartial({
        owner: borrower.user.publicKey,
        market: fx.market,
        obligation,
        ownerLoan: borrower.loanAta,
        loanVault: fx.loanVault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([borrower.user])
      .rpc();
    try {
      await program.methods
        .repay(new BN(1))
        .accountsPartial({
          owner: borrower.user.publicKey,
          market: fx.market,
          obligation,
          ownerLoan: borrower.loanAta,
          loanVault: fx.loanVault,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([borrower.user])
        .rpc();
      expect.fail("double repay should fail");
    } catch (err) {
      expect(String(err)).to.match(/InsufficientDebt|custom program error/i);
    }
  });

  it("still accepts repay while paused", async () => {
    const { fx, borrower, obligation } = await openPosition();
    await setPaused(program, true);
    try {
      await program.methods
        .repay(new BN(1_000_000))
        .accountsPartial({
          owner: borrower.user.publicKey,
          market: fx.market,
          obligation,
          ownerLoan: borrower.loanAta,
          loanVault: fx.loanVault,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([borrower.user])
        .rpc();
      expect(
        (await program.account.obligationPosition.fetch(obligation)).debtUnits.toString(),
      ).to.equal("99000000");
    } finally {
      await setPaused(program, false);
    }
  });

  it("does not reduce the lender claim", async () => {
    const { fx, units, borrower, obligation, lender } = await openPosition();
    await program.methods
      .repay(units)
      .accountsPartial({
        owner: borrower.user.publicKey,
        market: fx.market,
        obligation,
        ownerLoan: borrower.loanAta,
        loanVault: fx.loanVault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([borrower.user])
      .rpc();
    const claim = await program.account.claimPosition.fetch(
      pda(program.programId).claim(fx.market, lender.user.publicKey),
    );
    expect(claim.creditUnits.toString()).to.equal(units.toString());
    expect(
      (await program.account.termMarket.fetch(fx.market)).totalCreditUnits.toString(),
    ).to.equal(units.toString());
  });
});
