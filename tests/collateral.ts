import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import { TOKEN_PROGRAM_ID, createMint } from "@solana/spl-token";
import { SystemProgram } from "@solana/web3.js";
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

describe("collateral", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Zorya as Program<Zorya>;

  it("deposits and withdraws collateral with no debt", async () => {
    const fx = await createTestMarket(program);
    const amount = new BN(10_000_000_000);
    const { user, collateralAta } = await makeUser(program, fx, {
      collateral: 20_000_000_000n,
    });
    const obligation = await depositCollateral(
      program,
      fx,
      user,
      collateralAta,
      amount,
    );

    expect(await tokenBalance(provider.connection, fx.collateralVault)).to.equal(
      10_000_000_000n,
    );
    const pos = await program.account.obligationPosition.fetch(obligation);
    expect(pos.collateralAmount.toString()).to.equal(amount.toString());
    expect(pos.debtUnits.toNumber()).to.equal(0);

    await program.methods
      .withdrawCollateral(amount)
      .accountsPartial({
        owner: user.publicKey,
        config: fx.config,
        market: fx.market,
        collateralMint: fx.collateralMint,
        mockPrice: fx.mockPrice,
        priceUpdate: fx.mockPrice,
        ownerCollateral: collateralAta,
        collateralVault: fx.collateralVault,
        obligation,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();

    expect(await tokenBalance(provider.connection, fx.collateralVault)).to.equal(
      0n,
    );
    expect(
      (await program.account.obligationPosition.fetch(obligation))
        .collateralAmount.toNumber(),
    ).to.equal(0);
  });

  it("rejects a substituted collateral vault", async () => {
    const fx = await createTestMarket(program);
    const other = await createTestMarket(program);
    const { user, collateralAta } = await makeUser(program, fx, {
      collateral: 10_000_000_000n,
    });
    try {
      await program.methods
        .depositCollateral(new BN(1_000_000_000))
        .accountsPartial({
          owner: user.publicKey,
          market: fx.market,
          collateralMint: fx.collateralMint,
          ownerCollateral: collateralAta,
          collateralVault: other.collateralVault,
          obligation: pda(program.programId).obligation(
            fx.market,
            user.publicKey,
          ),
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();
      expect.fail("vault substitution should fail");
    } catch (err) {
      expect(String(err)).to.match(/ConstraintSeeds|custom program error|seeds/i);
    }
  });

  it("blocks withdraw while paused", async () => {
    const fx = await createTestMarket(program);
    const { user, collateralAta } = await makeUser(program, fx, {
      collateral: 5_000_000_000n,
    });
    const obligation = await depositCollateral(
      program,
      fx,
      user,
      collateralAta,
      new BN(5_000_000_000),
    );
    await setPaused(program, true);
    try {
      await program.methods
        .withdrawCollateral(new BN(1_000_000_000))
        .accountsPartial({
          owner: user.publicKey,
          config: fx.config,
          market: fx.market,
          collateralMint: fx.collateralMint,
          mockPrice: fx.mockPrice,
          priceUpdate: fx.mockPrice,
          ownerCollateral: collateralAta,
          collateralVault: fx.collateralVault,
          obligation,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user])
        .rpc();
      expect.fail("paused withdraw should fail");
    } catch (err) {
      expect(String(err)).to.match(/Paused|custom program error/i);
    } finally {
      await setPaused(program, false);
    }
  });

  it("still accepts deposit while paused", async () => {
    const fx = await createTestMarket(program);
    const { user, collateralAta } = await makeUser(program, fx, {
      collateral: 2_000_000_000n,
    });
    await setPaused(program, true);
    try {
      await depositCollateral(
        program,
        fx,
        user,
        collateralAta,
        new BN(2_000_000_000),
      );
      expect(await tokenBalance(provider.connection, fx.collateralVault)).to.equal(
        2_000_000_000n,
      );
    } finally {
      await setPaused(program, false);
    }
  });

  it("rejects a substituted collateral mint on withdraw", async () => {
    const fx = await createTestMarket(program);
    const { user, collateralAta } = await makeUser(program, fx, {
      collateral: 5_000_000_000n,
    });
    const obligation = await depositCollateral(
      program,
      fx,
      user,
      collateralAta,
      new BN(5_000_000_000),
    );
    const payer = (provider.wallet as anchor.Wallet).payer;
    const fakeMint = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      null,
      0,
    );
    try {
      await program.methods
        .withdrawCollateral(new BN(1_000_000_000))
        .accountsPartial({
          owner: user.publicKey,
          config: fx.config,
          market: fx.market,
          collateralMint: fakeMint,
          mockPrice: fx.mockPrice,
          priceUpdate: fx.mockPrice,
          ownerCollateral: collateralAta,
          collateralVault: fx.collateralVault,
          obligation,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user])
        .rpc();
      expect.fail("mint substitution should fail");
    } catch (err) {
      expect(String(err)).to.match(/MintMismatch|custom program error|constraint/i);
    }
  });

  it("rejects a withdraw that would make the position unhealthy", async () => {
    const fx = await createTestMarket(program);
    const lender = await makeUser(program, fx, { loan: 200_000_000n });
    const borrower = await makeUser(program, fx, {
      collateral: 10_000_000_000n,
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
      new BN(100_000_000),
    );
    try {
      await program.methods
        .withdrawCollateral(new BN(9_900_000_000))
        .accountsPartial({
          owner: borrower.user.publicKey,
          config: fx.config,
          market: fx.market,
          collateralMint: fx.collateralMint,
          mockPrice: fx.mockPrice,
          priceUpdate: fx.mockPrice,
          ownerCollateral: borrower.collateralAta,
          collateralVault: fx.collateralVault,
          obligation,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([borrower.user])
        .rpc();
      expect.fail("unhealthy withdraw should fail");
    } catch (err) {
      expect(String(err)).to.match(/Unhealthy|custom program error/i);
    }
  });
});
