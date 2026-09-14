import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import { Zorya } from "../target/types/zorya";
import { ZoryaClient } from "../sdk/src";
import {
  MIN_FILL,
  PRICE_E6,
  createTestMints,
  ensureConfig,
  makeUser,
  nowPlusDays,
} from "./helpers";

describe("sdk", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Zorya as Program<Zorya>;

  it("opens a position through the client: market → fill → repay", async () => {
    await ensureConfig(program);
    const client = new ZoryaClient(program);
    const { collateralMint, loanMint } = await createTestMints(program);
    const maturity = nowPlusDays(60);
    const keys = await client.createMarket({
      authority: provider.publicKey,
      collateralMint,
      loanMint,
      maturity,
      minFillUnits: MIN_FILL,
    });
    await program.methods
      .setMockPrice(PRICE_E6, new BN(0))
      .accountsPartial({
        authority: provider.publicKey,
        config: client.pdas.config(),
        market: keys.market,
        mockPrice: keys.mockPrice,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const fx = {
      collateralMint,
      loanMint,
      market: keys.market,
      loanVault: keys.loanVault,
      collateralVault: keys.collateralVault,
      curve: keys.curve,
      mockPrice: keys.mockPrice,
      maturity,
      config: client.pdas.config(),
    };
    const units = new BN(100_000_000);
    const lender = await makeUser(program, fx, { loan: 200_000_000n });
    const borrower = await makeUser(program, fx, {
      collateral: 10_000_000_000n,
      loan: 200_000_000n,
    });

    await client.depositCollateral({
      owner: borrower.user.publicKey,
      market: keys.market,
      collateralMint,
      ownerCollateral: borrower.collateralAta,
      collateralVault: keys.collateralVault,
      amount: new BN(10_000_000_000),
      signers: [borrower.user],
    });
    const { quote, quoteVault } = await client.createQuote({
      maker: lender.user.publicKey,
      market: keys.market,
      loanMint,
      makerLoan: lender.loanAta,
      seq: new BN(1),
      tick: 256,
      units,
      signers: [lender.user],
    });
    await client.fillQuote({
      taker: borrower.user.publicKey,
      market: keys.market,
      collateralMint,
      quote,
      quoteVault,
      takerLoan: borrower.loanAta,
      maker: lender.user.publicKey,
      makerLoan: lender.loanAta,
      mockPrice: keys.mockPrice,
      curve: keys.curve,
      maxUnits: units,
      signers: [borrower.user],
    });
    await client.repay({
      owner: borrower.user.publicKey,
      market: keys.market,
      ownerLoan: borrower.loanAta,
      loanVault: keys.loanVault,
      units,
      signers: [borrower.user],
    });

    const obligation = await program.account.obligationPosition.fetch(
      client.pdas.obligation(keys.market, borrower.user.publicKey),
    );
    expect(obligation.debtUnits.toNumber()).to.equal(0);
    const claim = await program.account.claimPosition.fetch(
      client.pdas.claim(keys.market, lender.user.publicKey),
    );
    expect(claim.creditUnits.toString()).to.equal(units.toString());
  });
});
