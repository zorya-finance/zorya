import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import { Zorya } from "../target/types/zorya";
import { impliedReturnWad, priceFromWad, readCurve } from "../sdk/src";
import {
  createQuoteIx,
  createTestMarket,
  depositCollateral,
  fillQuote,
  makeUser,
  nowPlusDays,
  pda,
} from "./helpers";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair } from "@solana/web3.js";

describe("curve", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Zorya as Program<Zorya>;

  it("sorts three tenors on one PDA and records only the filled slot", async () => {
    const late = await createTestMarket(program, { maturity: nowPlusDays(120) });
    const early = await createTestMarket(program, {
      collateralMint: late.collateralMint,
      loanMint: late.loanMint,
      maturity: nowPlusDays(60),
    });
    const mid = await createTestMarket(program, {
      collateralMint: late.collateralMint,
      loanMint: late.loanMint,
      maturity: nowPlusDays(90),
    });
    expect(early.curve.toBase58()).to.equal(late.curve.toBase58());
    expect(mid.curve.toBase58()).to.equal(late.curve.toBase58());

    const units = new BN(100_000_000);
    const lender = await makeUser(program, mid, { loan: 200_000_000n });
    const borrower = await makeUser(program, mid, {
      collateral: 10_000_000_000n,
    });
    await depositCollateral(
      program,
      mid,
      borrower.user,
      borrower.collateralAta,
      new BN(10_000_000_000),
    );
    const { quote, quoteVault } = await createQuoteIx(
      program,
      mid,
      lender.user,
      lender.loanAta,
      new BN(1),
      256,
      units,
    );
    await fillQuote(
      program,
      mid,
      quote,
      quoteVault,
      borrower.user,
      borrower.loanAta,
      lender.user.publicKey,
      lender.loanAta,
      units,
    );

    const view = await readCurve(program, late.collateralMint, late.loanMint);
    expect(view).to.not.equal(null);
    expect(view!.address.toBase58()).to.equal(late.curve.toBase58());
    expect(view!.tenorCount).to.equal(3);
    expect(view!.points.map((p) => p.maturityTs)).to.deep.equal([
      early.maturity.toNumber(),
      mid.maturity.toNumber(),
      late.maturity.toNumber(),
    ]);
    expect(view!.points[0].printed).to.equal(false);
    expect(view!.points[0].cumulativeUnits.toString()).to.equal("0");
    expect(view!.points[1].printed).to.equal(true);
    expect(view!.points[1].cumulativeUnits.toString()).to.equal(units.toString());
    expect(view!.points[1].lastPriceWad.toString()).to.equal(
      "500000000000000000",
    );
    expect(view!.points[2].printed).to.equal(false);

    const ret = impliedReturnWad(view!.points[1].lastPriceWad);
    expect(ret!.toString()).to.equal("1000000000000000000");
  });

  it("accumulates volume and overwrites the last print on a second fill", async () => {
    const fx = await createTestMarket(program, { maturity: nowPlusDays(60) });
    const first = new BN(100_000_000);
    const second = new BN(40_000_000);
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
    const q1 = await createQuoteIx(
      program,
      fx,
      lender.user,
      lender.loanAta,
      new BN(1),
      256,
      first,
    );
    await fillQuote(
      program,
      fx,
      q1.quote,
      q1.quoteVault,
      borrower.user,
      borrower.loanAta,
      lender.user.publicKey,
      lender.loanAta,
      first,
    );
    const q2 = await createQuoteIx(
      program,
      fx,
      lender.user,
      lender.loanAta,
      new BN(2),
      240,
      second,
    );
    await fillQuote(
      program,
      fx,
      q2.quote,
      q2.quoteVault,
      borrower.user,
      borrower.loanAta,
      lender.user.publicKey,
      lender.loanAta,
      second,
    );

    const view = await readCurve(program, fx.collateralMint, fx.loanMint);
    expect(view!.points[0].cumulativeUnits.toString()).to.equal(
      first.add(second).toString(),
    );
    expect(view!.points[0].lastPriceWad.toString()).to.not.equal(
      "500000000000000000",
    );
    expect(view!.points[0].printed).to.equal(true);
  });

  it("rejects a fill that substitutes another pair's curve", async () => {
    const fx = await createTestMarket(program, { maturity: nowPlusDays(60) });
    const other = await createTestMarket(program, { maturity: nowPlusDays(60) });
    const units = new BN(100_000_000);
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
      units,
    );
    try {
      await program.methods
        .fillQuote(units)
        .accountsPartial({
          taker: borrower.user.publicKey,
          config: fx.config,
          market: fx.market,
          collateralMint: fx.collateralMint,
          quote,
          quoteVault,
          takerLoan: borrower.loanAta,
          makerLoan: lender.loanAta,
          claim: pda(program.programId).claim(fx.market, lender.user.publicKey),
          obligation: pda(program.programId).obligation(
            fx.market,
            borrower.user.publicKey,
          ),
          mockPrice: fx.mockPrice,
          priceUpdate: fx.mockPrice,
          curve: other.curve,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([borrower.user])
        .rpc();
      expect.fail("foreign curve should fail");
    } catch (err) {
      expect(String(err)).to.match(
        /ConstraintSeeds|CurvePairMismatch|custom program error|constraint/i,
      );
    }
  });

  it("returns null for a pair that has no curve PDA", async () => {
    const missing = await readCurve(
      program,
      Keypair.generate().publicKey,
      Keypair.generate().publicKey,
    );
    expect(missing).to.equal(null);
  });
});

describe("curve math", () => {
  it("derives remaining return from P and rejects a zero print", () => {
    expect(impliedReturnWad(new BN(0))).to.equal(null);
    const half = new BN("500000000000000000");
    expect(impliedReturnWad(half)!.toString()).to.equal("1000000000000000000");
    expect(priceFromWad(half)).to.equal(0.5);
    expect(priceFromWad(new BN(0))).to.equal(0);
  });
});
