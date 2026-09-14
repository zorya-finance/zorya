import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Zorya } from "../target/types/zorya";
import {
  liquidate,
  makeUser,
  nowPlusSecs,
  openFilledMarket,
  parsedEvent,
  pda,
  redeem,
  setPaused,
  tokenBalance,
  waitUntilUnix,
} from "./helpers";

describe("redeem", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Zorya as Program<Zorya>;

  async function repayUnits(
    fx: { market: anchor.web3.PublicKey; loanVault: anchor.web3.PublicKey },
    borrower: { user: anchor.web3.Keypair; loanAta: anchor.web3.PublicKey },
    obligation: anchor.web3.PublicKey,
    amount: BN,
  ) {
    await program.methods
      .repay(amount)
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
  }

  it("rejects redeem before maturity", async () => {
    const { fx, units, lender } = await openFilledMarket(program);
    try {
      await redeem(program, fx, lender.user, lender.loanAta, units);
      expect.fail("early redeem should fail");
    } catch (err) {
      expect(String(err)).to.match(/MarketNotMatured|custom program error/i);
    }
  });

  it("redeems at par after the borrower repays", async () => {
    const { fx, units, lender, borrower, obligation } = await openFilledMarket(
      program,
      { maturity: nowPlusSecs(50) },
    );
    await repayUnits(fx, borrower, obligation, units);
    await waitUntilUnix(provider.connection, fx.maturity.toNumber());
    const before = await tokenBalance(provider.connection, lender.loanAta);
    const sig = await redeem(program, fx, lender.user, lender.loanAta, units);
    expect(await tokenBalance(provider.connection, lender.loanAta)).to.equal(
      before + BigInt(units.toString()),
    );
    const claim = await program.account.claimPosition.fetch(
      pda(program.programId).claim(fx.market, lender.user.publicKey),
    );
    expect(claim.creditUnits.toNumber()).to.equal(0);
    expect(
      (await program.account.termMarket.fetch(fx.market)).status,
    ).to.deep.equal({ matured: {} });
    const ev = await parsedEvent(program, sig, "redeemed");
    expect(ev).to.not.equal(undefined);
    expect((ev!.data as { payout: BN }).payout.toString()).to.equal(
      units.toString(),
    );
  });

  it("redeems partially when the vault is short", async () => {
    const { fx, units, lender, borrower, obligation } = await openFilledMarket(
      program,
      { maturity: nowPlusSecs(50) },
    );
    await repayUnits(fx, borrower, obligation, new BN(40_000_000));
    await waitUntilUnix(provider.connection, fx.maturity.toNumber());
    await redeem(program, fx, lender.user, lender.loanAta, units);
    const claim = await program.account.claimPosition.fetch(
      pda(program.programId).claim(fx.market, lender.user.publicKey),
    );
    expect(claim.creditUnits.toString()).to.equal("60000000");
    expect(await tokenBalance(provider.connection, fx.loanVault)).to.equal(0n);
  });

  it("rejects redeem when the vault is empty", async () => {
    const { fx, units, lender } = await openFilledMarket(program, {
      maturity: nowPlusSecs(50),
    });
    await waitUntilUnix(provider.connection, fx.maturity.toNumber());
    try {
      await redeem(program, fx, lender.user, lender.loanAta, units);
      expect.fail("empty vault should fail");
    } catch (err) {
      expect(String(err)).to.match(/InsufficientVault|custom program error/i);
    }
  });

  it("still accepts redeem while paused", async () => {
    const { fx, units, lender, borrower, obligation } = await openFilledMarket(
      program,
      { maturity: nowPlusSecs(50) },
    );
    await repayUnits(fx, borrower, obligation, units);
    await waitUntilUnix(provider.connection, fx.maturity.toNumber());
    await setPaused(program, true);
    try {
      await redeem(program, fx, lender.user, lender.loanAta, units);
      const claim = await program.account.claimPosition.fetch(
        pda(program.programId).claim(fx.market, lender.user.publicKey),
      );
      expect(claim.creditUnits.toNumber()).to.equal(0);
    } finally {
      await setPaused(program, false);
    }
  });

  it("rejects a second full redeem", async () => {
    const { fx, units, lender, borrower, obligation } = await openFilledMarket(
      program,
      { maturity: nowPlusSecs(50) },
    );
    await repayUnits(fx, borrower, obligation, units);
    await waitUntilUnix(provider.connection, fx.maturity.toNumber());
    await redeem(program, fx, lender.user, lender.loanAta, units);
    try {
      await redeem(program, fx, lender.user, lender.loanAta, new BN(1));
      expect.fail("double redeem should fail");
    } catch (err) {
      expect(String(err)).to.match(/InsufficientCredit|custom program error/i);
    }
  });

  it("haircuts redeem after realized bad debt", async () => {
    const { fx, units, lender, borrower } = await openFilledMarket(program, {
      maturity: nowPlusSecs(50),
    });
    await program.methods
      .setMockPrice(new BN(1_000_000), new BN(0))
      .accountsPartial({
        authority: provider.publicKey,
        config: fx.config,
        market: fx.market,
        mockPrice: fx.mockPrice,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
    const liq = await makeUser(program, fx, { loan: 200_000_000n });
    await liquidate(
      program,
      fx,
      "health",
      borrower.user.publicKey,
      liq.user,
      liq.loanAta,
      liq.collateralAta,
      new BN(20_000_000),
    );
    await waitUntilUnix(provider.connection, fx.maturity.toNumber());
    const before = await tokenBalance(provider.connection, lender.loanAta);
    await redeem(program, fx, lender.user, lender.loanAta, units);
    const received =
      (await tokenBalance(provider.connection, lender.loanAta)) - before;
    expect(received < BigInt(units.toString())).to.equal(true);
    expect(received > 0n).to.equal(true);
  });

  it("does not reduce the borrower obligation", async () => {
    const { fx, units, lender, borrower, obligation } = await openFilledMarket(
      program,
      { maturity: nowPlusSecs(50) },
    );
    await repayUnits(fx, borrower, obligation, new BN(50_000_000));
    await waitUntilUnix(provider.connection, fx.maturity.toNumber());
    const debtBefore = (
      await program.account.obligationPosition.fetch(obligation)
    ).debtUnits;
    await redeem(program, fx, lender.user, lender.loanAta, units);
    expect(
      (await program.account.obligationPosition.fetch(obligation)).debtUnits.toString(),
    ).to.equal(debtBefore.toString());
  });
});
