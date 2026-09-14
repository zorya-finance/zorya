import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import { Zorya } from "../target/types/zorya";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  PRICE_E6,
  PYTH_RECEIVER,
  SOL_USD_FEED_ID,
  createQuoteIx,
  createTestMarket,
  depositCollateral,
  fillQuote,
  makeUser,
} from "./helpers";

describe("oracle", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Zorya as Program<Zorya>;

  it("creates a Pyth market with the SOL/USD feed and receiver program", async () => {
    const fx = await createTestMarket(program, {
      oracleFeedId: SOL_USD_FEED_ID,
    });
    const market = await program.account.termMarket.fetch(fx.market);
    expect(market.oracleKind).to.equal(1);
    expect(market.oracleProgram.toBase58()).to.equal(PYTH_RECEIVER.toBase58());
    expect(Array.from(market.oracleFeedId)).to.deep.equal(SOL_USD_FEED_ID);
  });

  it("rejects a Pyth fill when the price update is not owned by the receiver", async () => {
    const fx = await createTestMarket(program, {
      oracleFeedId: SOL_USD_FEED_ID,
    });
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
    try {
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
      expect.fail("unowned price update should fail");
    } catch (err) {
      expect(String(err)).to.match(
        /OracleOwnerMismatch|custom program error/i,
      );
    }
  });

  it("rejects a Pyth withdraw when the price update is not owned by the receiver", async () => {
    const fx = await createTestMarket(program, {
      oracleFeedId: SOL_USD_FEED_ID,
    });
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
      expect.fail("unowned price update should fail");
    } catch (err) {
      expect(String(err)).to.match(
        /OracleOwnerMismatch|custom program error/i,
      );
    }
  });

  it("rejects set_mock_price on a Pyth market", async () => {
    const fx = await createTestMarket(program, {
      oracleFeedId: SOL_USD_FEED_ID,
    });
    try {
      await program.methods
        .setMockPrice(PRICE_E6, new BN(0))
        .accountsPartial({
          authority: provider.publicKey,
          config: fx.config,
          market: fx.market,
          mockPrice: fx.mockPrice,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
      expect.fail("mock price on Pyth market should fail");
    } catch (err) {
      expect(String(err)).to.match(
        /InvalidMarketParams|custom program error/i,
      );
    }
  });
});
