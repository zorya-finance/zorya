import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import type { Zorya } from "../target/types/zorya";
import { cancelQuote, createQuoteIx, createTestMarket, depositCollateral, fillQuote,
  liquidate, makeUser, pda, tokenBalance } from "./helpers";

describe("005: close credit issuance after a recorded loss", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Zorya as Program<Zorya>;
  const face = new BN(1_000_000_000);

  async function lossWithOpenQuote() {
    const fx = await createTestMarket(program);
    const lender = await makeUser(program, fx, { loan: 3_000_000_000n });
    const borrower = await makeUser(program, fx, { collateral: 9_890_109_890n });
    const later = await makeUser(program, fx, { collateral: 20_000_000_000n });
    const liq = await makeUser(program, fx, { loan: 1_000_000_000n });
    await depositCollateral(program, fx, borrower.user, borrower.collateralAta, new BN("9890109890"));
    await depositCollateral(program, fx, later.user, later.collateralAta, new BN("20000000000"));
    const first = await createQuoteIx(program, fx, lender.user, lender.loanAta, new BN(1), 512, face);
    await fillQuote(program, fx, first.quote, first.quoteVault, borrower.user, borrower.loanAta, lender.user.publicKey, lender.loanAta, face);
    const existing = await createQuoteIx(program, fx, lender.user, lender.loanAta, new BN(2), 512, face);
    await program.methods.setMockPrice(new BN(100_000_000), new BN(0)).accountsPartial({
      authority: provider.publicKey, config: fx.config, market: fx.market, mockPrice: fx.mockPrice,
    }).rpc();
    await liquidate(program, fx, "health", borrower.user.publicKey, liq.user, liq.loanAta, liq.collateralAta, new BN(900_000_000));
    const state = await program.account.termMarket.fetch(fx.market);
    expect(state.lossFactorWad.toString()).to.equal("100000000000000000");
    expect(state.totalDebtUnits.toString()).to.equal("0");
    expect(state.status).to.have.property("active");
    return { fx, lender, later, existing };
  }

  async function rejectsWithoutChanges(action: () => Promise<unknown>, addresses: anchor.web3.PublicKey[]) {
    const snapshot = async () => (await provider.connection.getMultipleAccountsInfo(addresses)).map(a => a?.data.toString("base64"));
    const before = await snapshot();
    let caught: unknown;
    try { await action(); } catch (error) { caught = error; }
    expect(caught, "issuance must reject on an impaired market").to.be.instanceOf(anchor.AnchorError);
    expect((caught as anchor.AnchorError).error.errorCode.code).to.equal("MarketImpaired");
    expect(await snapshot()).to.deep.equal(before);
  }

  it("rejects new quotes after a pre-maturity loss and still lets the lender cancel existing escrow", async () => {
    const { fx, lender, existing } = await lossWithOpenQuote();
    const quote = pda(program.programId).quote(fx.market, lender.user.publicKey, new BN(3));
    await rejectsWithoutChanges(() => createQuoteIx(program, fx, lender.user, lender.loanAta, new BN(3), 512, face),
      [fx.market, fx.loanVault, lender.loanAta, quote]);
    const escrow = await tokenBalance(provider.connection, existing.quoteVault);
    const before = await tokenBalance(provider.connection, lender.loanAta);
    await cancelQuote(program, fx, lender.user, lender.loanAta, existing.quote, existing.quoteVault);
    expect(await tokenBalance(provider.connection, lender.loanAta)).to.equal(before + escrow);
  });

  it("rejects fills of quotes posted before the loss without moving tokens or creating credit", async () => {
    const { fx, lender, later, existing } = await lossWithOpenQuote();
    await rejectsWithoutChanges(() => fillQuote(program, fx, existing.quote, existing.quoteVault, later.user,
      later.loanAta, lender.user.publicKey, lender.loanAta, face),
    [fx.market, existing.quote, existing.quoteVault, later.loanAta,
      pda(program.programId).claim(fx.market, lender.user.publicKey),
      pda(program.programId).obligation(fx.market, later.user.publicKey)]);
  });
});
