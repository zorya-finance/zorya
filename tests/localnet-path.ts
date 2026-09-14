import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import { Zorya } from "../target/types/zorya";
import {
  createQuoteIx,
  createTestMarket,
  depositCollateral,
  fillQuote,
  liquidate,
  makeUser,
  nowPlusSecs,
  pda,
  redeem,
  repay,
  tokenBalance,
  waitUntilUnix,
} from "./helpers";

/**
 * Sprint 4 localnet path: one market, lend → borrow → repay → redeem,
 * and a second market that goes through health liquidation.
 */
describe("localnet path", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Zorya as Program<Zorya>;

  it("lend, borrow, repay, redeem on one calendar market", async () => {
    const fx = await createTestMarket(program, { maturity: nowPlusSecs(50) });
    const face = new BN(100_000_000);
    const lender = await makeUser(program, fx, { loan: 200_000_000n });
    const borrower = await makeUser(program, fx, {
      collateral: 10_000_000_000n,
      loan: 200_000_000n,
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
      face,
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
      face,
    );

    const claimPk = pda(program.programId).claim(
      fx.market,
      lender.user.publicKey,
    );
    const obligationPk = pda(program.programId).obligation(
      fx.market,
      borrower.user.publicKey,
    );
    const claim = await program.account.claimPosition.fetch(claimPk);
    const obligation = await program.account.obligationPosition.fetch(
      obligationPk,
    );
    const marketAfterFill = await program.account.termMarket.fetch(fx.market);
    expect(claim.creditUnits.toString()).to.equal(face.toString());
    expect(obligation.debtUnits.toString()).to.equal(face.toString());
    expect(marketAfterFill.totalCreditUnits.toString()).to.equal(face.toString());
    expect(marketAfterFill.totalDebtUnits.toString()).to.equal(face.toString());
    expect(obligation.collateralAmount.toString()).to.equal("10000000000");
    expect(await tokenBalance(provider.connection, fx.collateralVault)).to.equal(
      10_000_000_000n,
    );
    expect(await tokenBalance(provider.connection, fx.loanVault)).to.equal(0n);

    await repay(program, fx, borrower.user, borrower.loanAta, face);
    expect(
      (await program.account.obligationPosition.fetch(obligationPk)).debtUnits.toNumber(),
    ).to.equal(0);
    const marketAfterRepay = await program.account.termMarket.fetch(fx.market);
    expect(marketAfterRepay.totalDebtUnits.toNumber()).to.equal(0);
    expect(marketAfterRepay.totalCreditUnits.toString()).to.equal(face.toString());
    expect(await tokenBalance(provider.connection, fx.loanVault)).to.equal(
      BigInt(face.toString()),
    );

    await waitUntilUnix(provider.connection, fx.maturity.toNumber());
    const before = await tokenBalance(provider.connection, lender.loanAta);
    await redeem(program, fx, lender.user, lender.loanAta, face);
    expect(await tokenBalance(provider.connection, lender.loanAta)).to.equal(
      before + BigInt(face.toString()),
    );
    expect(
      (await program.account.claimPosition.fetch(claimPk)).creditUnits.toNumber(),
    ).to.equal(0);
    const marketAfterRedeem = await program.account.termMarket.fetch(fx.market);
    expect(marketAfterRedeem.totalCreditUnits.toNumber()).to.equal(0);
    expect(await tokenBalance(provider.connection, fx.loanVault)).to.equal(0n);
  });

  it("lend, borrow, crash mark, health-liquidate", async () => {
    const fx = await createTestMarket(program);
    const face = new BN(100_000_000);
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
      face,
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
      face,
    );

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

    const liq = await makeUser(program, fx, { loan: 200_000_000n });
    const collBefore = await tokenBalance(
      provider.connection,
      liq.collateralAta,
    );
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
    const collAfter = await tokenBalance(provider.connection, liq.collateralAta);
    expect(collAfter > collBefore).to.equal(true);
    const marketAfterLiq = await program.account.termMarket.fetch(fx.market);
    expect(marketAfterLiq.totalCreditUnits.toString()).to.equal(face.toString());
    expect(marketAfterLiq.totalDebtUnits.toString()).to.equal(
      face.sub(new BN(10_000_000)).toString(),
    );
    const debt = (
      await program.account.obligationPosition.fetch(
        pda(program.programId).obligation(fx.market, borrower.user.publicKey),
      )
    ).debtUnits;
    expect(debt.toString()).to.equal(face.sub(new BN(10_000_000)).toString());
  });
});
