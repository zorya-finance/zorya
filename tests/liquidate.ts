import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Zorya } from "../target/types/zorya";
import {
  createTestMarket,
  liquidate,
  makeUser,
  nowPlusSecs,
  openFilledMarket,
  parsedEvent,
  pda,
  setPaused,
  tokenBalance,
  waitUntilUnix,
} from "./helpers";

describe("liquidate", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Zorya as Program<Zorya>;

  async function crashPrice(fx: { config: anchor.web3.PublicKey; market: anchor.web3.PublicKey; mockPrice: anchor.web3.PublicKey }, price = new BN(1_000_000)) {
    await program.methods
      .setMockPrice(price, new BN(0))
      .accountsPartial({
        authority: provider.publicKey,
        config: fx.config,
        market: fx.market,
        mockPrice: fx.mockPrice,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
  }

  it("rejects a health liquidation while the position is healthy", async () => {
    const { fx, borrower } = await openFilledMarket(program);
    const liq = await makeUser(program, fx, { loan: 200_000_000n });
    try {
      await liquidate(
        program,
        fx,
        "health",
        borrower.user.publicKey,
        liq.user,
        liq.loanAta,
        liq.collateralAta,
        new BN(10_000_000),
      );
      expect.fail("healthy liquidate should fail");
    } catch (err) {
      expect(String(err)).to.match(/HealthyPosition|custom program error/i);
    }
  });

  it("health-liquidates an underwater position and seizes a bonus", async () => {
    const { fx, units, borrower, obligation } = await openFilledMarket(program);
    // $13/SOL: unhealthy (max ~91 USDC vs 100 debt) but RCF < full close.
    await crashPrice(fx, new BN(13_000_000));
    const liq = await makeUser(program, fx, { loan: 200_000_000n });
    const repaid = new BN(10_000_000);
    const beforeColl = await tokenBalance(
      provider.connection,
      liq.collateralAta,
    );
    const sig = await liquidate(
      program,
      fx,
      "health",
      borrower.user.publicKey,
      liq.user,
      liq.loanAta,
      liq.collateralAta,
      repaid,
    );
    const seized = await tokenBalance(provider.connection, liq.collateralAta);
    expect(seized > beforeColl).to.equal(true);
    const pos = await program.account.obligationPosition.fetch(obligation);
    expect(pos.debtUnits.toString()).to.equal(
      units.sub(repaid).toString(),
    );
    const ev = await parsedEvent(program, sig, "liquidated");
    expect(ev).to.not.equal(undefined);
    expect((ev!.data as { path: number }).path).to.equal(0);
  });

  it("rejects a health repay above the recovery close factor", async () => {
    const { fx, units, borrower } = await openFilledMarket(program);
    // Mild crash: still underwater, but leftover coll after RCF is not dust.
    await crashPrice(fx, new BN(13_000_000));
    const liq = await makeUser(program, fx, { loan: 400_000_000n });
    try {
      await liquidate(
        program,
        fx,
        "health",
        borrower.user.publicKey,
        liq.user,
        liq.loanAta,
        liq.collateralAta,
        units,
      );
      expect.fail("over-liquidate should fail");
    } catch (err) {
      expect(String(err)).to.match(/OverLiquidation|HealthyPosition|custom program error/i);
    }
  });

  it("rejects default liquidation before maturity", async () => {
    const { fx, borrower } = await openFilledMarket(program);
    const liq = await makeUser(program, fx, { loan: 200_000_000n });
    try {
      await liquidate(
        program,
        fx,
        "default",
        borrower.user.publicKey,
        liq.user,
        liq.loanAta,
        liq.collateralAta,
        new BN(10_000_000),
      );
      expect.fail("early default should fail");
    } catch (err) {
      expect(String(err)).to.match(/NotPastMaturity|custom program error/i);
    }
  });

  it("default-liquidates a healthy late borrower after maturity", async () => {
    const { fx, units, borrower, obligation } = await openFilledMarket(program, {
      maturity: nowPlusSecs(50),
    });
    const liq = await makeUser(program, fx, { loan: 200_000_000n });
    await waitUntilUnix(provider.connection, fx.maturity.toNumber());
    const beforeColl = await tokenBalance(
      provider.connection,
      liq.collateralAta,
    );
    await liquidate(
      program,
      fx,
      "default",
      borrower.user.publicKey,
      liq.user,
      liq.loanAta,
      liq.collateralAta,
      new BN(20_000_000),
    );
    const seized = await tokenBalance(provider.connection, liq.collateralAta);
    expect(seized > beforeColl).to.equal(true);
    // Just after maturity the ramp is tiny, so seize ≈ repaid / price (no 10% bonus).
    const pos = await program.account.obligationPosition.fetch(obligation);
    expect(pos.debtUnits.toString()).to.equal(
      units.sub(new BN(20_000_000)).toString(),
    );
  });

  it("still accepts liquidation while paused", async () => {
    const { fx, borrower } = await openFilledMarket(program);
    await crashPrice(fx, new BN(13_000_000));
    const liq = await makeUser(program, fx, { loan: 200_000_000n });
    await setPaused(program, true);
    try {
      await liquidate(
        program,
        fx,
        "health",
        borrower.user.publicKey,
        liq.user,
        liq.loanAta,
        liq.collateralAta,
        new BN(10_000_000),
      );
    } finally {
      await setPaused(program, false);
    }
  });

  it("rejects a substituted collateral vault on liquidate", async () => {
    const { fx, borrower } = await openFilledMarket(program);
    const other = await createTestMarket(program);
    await crashPrice(fx, new BN(13_000_000));
    const liq = await makeUser(program, fx, { loan: 200_000_000n });
    try {
      await program.methods
        .liquidateHealth(new BN(10_000_000))
        .accountsPartial({
          liquidator: liq.user.publicKey,
          borrower: borrower.user.publicKey,
          market: fx.market,
          obligation: pda(program.programId).obligation(
            fx.market,
            borrower.user.publicKey,
          ),
          mockPrice: fx.mockPrice,
          priceUpdate: fx.mockPrice,
          liquidatorLoan: liq.loanAta,
          liquidatorCollateral: liq.collateralAta,
          loanVault: fx.loanVault,
          collateralVault: other.collateralVault,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([liq.user])
        .rpc();
      expect.fail("vault substitution should fail");
    } catch (err) {
      expect(String(err)).to.match(/ConstraintSeeds|custom program error|seeds/i);
    }
  });

  it("realizes bad debt and raises the loss factor", async () => {
    const { fx, borrower, obligation } = await openFilledMarket(program);
    await crashPrice(fx, new BN(1_000_000));
    const liq = await makeUser(program, fx, { loan: 200_000_000n });
    // Small repay seizes all 10 SOL at $1/SOL and leaves leftover debt.
    const sig = await liquidate(
      program,
      fx,
      "health",
      borrower.user.publicKey,
      liq.user,
      liq.loanAta,
      liq.collateralAta,
      new BN(20_000_000),
    );
    const pos = await program.account.obligationPosition.fetch(obligation);
    expect(pos.debtUnits.toNumber()).to.equal(0);
    expect(pos.collateralAmount.toNumber()).to.equal(0);
    const market = await program.account.termMarket.fetch(fx.market);
    expect(market.lossFactorWad.gt(new BN(0))).to.equal(true);
    expect(market.totalDebtUnits.toNumber()).to.equal(0);
    const ev = await parsedEvent(program, sig, "lossFactorUpdated");
    expect(ev).to.not.equal(undefined);
  });
});
