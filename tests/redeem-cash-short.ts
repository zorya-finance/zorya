import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import { getAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { Zorya } from "../target/types/zorya";
import fixture from "./fixtures/settled-cash-short/manifest.json";
import { parsedEvent } from "./helpers";

describe("redeem: settled cash-short state (Q18)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Zorya as anchor.Program<Zorya>;
  // Public local-test key, also used by scripts/generate-q18-fixtures.cjs.
  const owner = anchor.web3.Keypair.fromSeed(Buffer.alloc(32, 81));
  const market = new anchor.web3.PublicKey(fixture.market);
  const claim = new anchor.web3.PublicKey(fixture.claim);
  const loanVault = new anchor.web3.PublicKey(fixture.loanVault);
  const ownerLoan = new anchor.web3.PublicKey(fixture.ownerLoan);
  const accounts = {
    owner: owner.publicKey,
    market,
    claim,
    loanVault,
    ownerLoan,
    tokenProgram: TOKEN_PROGRAM_ID,
  };
  const redeem = (units: number) =>
    program.methods
      .redeem(new anchor.BN(units))
      .accountsPartial(accounts)
      .signers([owner])
      .rpc();

  it("pays available cash, burns only covered face and preserves the remainder with debt zero", async () => {
    // Anchor.toml preloads a synthetic settled state, not a reachable-book claim.
    const before = await program.account.termMarket.fetch(market);
    expect(before.totalDebtUnits.toString()).to.equal("0");
    expect(before.totalCreditUnits.toString()).to.equal("100000000");
    expect(before.lossFactorWad.toString()).to.equal("500000000000000000");
    expect(
      (await program.account.claimPosition.fetch(claim)).creditUnits.toString(),
    ).to.equal("100000000");
    expect((await getAccount(provider.connection, loanVault)).amount).to.equal(
      20_000_000n,
    );
    expect((await getAccount(provider.connection, ownerLoan)).amount).to.equal(
      0n,
    );

    const signature = await redeem(100_000_000);
    expect((await getAccount(provider.connection, ownerLoan)).amount).to.equal(
      20_000_000n,
    );
    expect((await getAccount(provider.connection, loanVault)).amount).to.equal(
      0n,
    );
    expect(
      (await program.account.claimPosition.fetch(claim)).creditUnits.toString(),
    ).to.equal("60000000");
    const after = await program.account.termMarket.fetch(market);
    expect(after.totalCreditUnits.toString()).to.equal("60000000");
    expect(after.totalDebtUnits.toString()).to.equal("0");
    expect(after.lossFactorWad.toString()).to.equal(
      before.lossFactorWad.toString(),
    );
    const event = await parsedEvent(program, signature, "redeemed");
    expect(event).to.not.equal(undefined);
    const data = event!.data as { units: anchor.BN; payout: anchor.BN };
    expect(data.units.toString()).to.equal("40000000");
    expect(data.payout.toString()).to.equal("20000000");

    const keys = [market, claim, loanVault, ownerLoan];
    const snapshot = async () =>
      (await provider.connection.getMultipleAccountsInfo(keys)).map((a) =>
        a?.data.toString("base64"),
      );
    const state = await snapshot();
    let caught: unknown;
    try {
      await redeem(60_000_000);
    } catch (error) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(anchor.AnchorError);
    expect((caught as anchor.AnchorError).error.errorCode.code).to.equal(
      "InsufficientVault",
    );
    expect(await snapshot()).to.deep.equal(state);
  });
});
