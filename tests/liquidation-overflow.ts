import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import type { Zorya } from "../target/types/zorya";
import {
  createQuoteIx,
  createTestMarket,
  depositCollateral,
  fillQuote,
  liquidate,
  makeUser,
  tokenBalance,
} from "./helpers";

describe("006: large-position liquidation", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Zorya as Program<Zorya>;

  it("health-liquidates one USDC of a 500,000-USDC position after a valid price move", async () => {
    const fx = await createTestMarket(program);
    const lender = await makeUser(program, fx, { loan: 600_000_000_000n });
    const borrower = await makeUser(program, fx, {
      collateral: 4_000_000_000_000n,
    });
    const liq = await makeUser(program, fx, { loan: 10_000_000n });
    const obligation = await depositCollateral(
      program,
      fx,
      borrower.user,
      borrower.collateralAta,
      new BN("4000000000000"),
    );
    const quote = await createQuoteIx(
      program,
      fx,
      lender.user,
      lender.loanAta,
      new BN(1),
      512,
      new BN("500000000000"),
    );
    await fillQuote(
      program,
      fx,
      quote.quote,
      quote.quoteVault,
      borrower.user,
      borrower.loanAta,
      lender.user.publicKey,
      lender.loanAta,
      new BN("500000000000"),
    );
    await program.methods
      .setMockPrice(new BN(150_000_000), new BN(0))
      .accountsPartial({
        authority: provider.publicKey,
        config: fx.config,
        market: fx.market,
        mockPrice: fx.mockPrice,
      })
      .rpc();
    await liquidate(
      program,
      fx,
      "health",
      borrower.user.publicKey,
      liq.user,
      liq.loanAta,
      liq.collateralAta,
      new BN(1_000_000),
    );
    const state = await program.account.obligationPosition.fetch(obligation);
    expect(state.debtUnits.toString()).to.equal("499999000000");
    const expected =
      (1_000_000n * 1_098_901_098_901_098_901n * 1_000_000_000n) /
      (1_000_000_000_000_000_000n * 150_000_000n);
    expect(await tokenBalance(provider.connection, liq.collateralAta)).to.equal(
      expected,
    );
    expect(state.collateralAmount.toString()).to.equal(
      (4_000_000_000_000n - expected).toString(),
    );
  });
});
