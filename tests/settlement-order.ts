import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Transaction } from "@solana/web3.js";
import type { Zorya } from "../target/types/zorya";
import {
  createQuoteIx,
  createTestMarket,
  depositCollateral,
  fillQuote,
  liquidate,
  makeUser,
  pda,
  redeem,
  repay,
  tokenBalance,
  validatorUnix,
  waitUntilUnix,
} from "./helpers";

describe("redeem after debt settlement (001)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Zorya as Program<Zorya>;
  const connection = provider.connection;
  const face = new BN(100_000_000);
  const collateral = new BN(10_000_000_000);

  async function price(
    fx: Awaited<ReturnType<typeof createTestMarket>>,
    conf = 0,
  ) {
    await program.methods
      .setMockPrice(new BN(1_000_000), new BN(conf))
      .accountsPartial({
        authority: provider.publicKey,
        config: fx.config,
        market: fx.market,
        mockPrice: fx.mockPrice,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
  }

  // Same two-lender/two-borrower setup as the original 100/10 versus 55/55 probe.
  async function prepare() {
    const fx = await createTestMarket(program, {
      maturity: new BN((await validatorUnix(connection)) + 75),
    });
    const lenders = [];
    const borrowers = [];
    for (let i = 0; i < 2; i++) {
      const lender = await makeUser(program, fx, { loan: 200_000_000n });
      const borrower = await makeUser(program, fx, {
        collateral: 10_000_000_000n,
        loan: 100_000_000n,
      });
      lenders.push(lender);
      borrowers.push(borrower);
      await depositCollateral(
        program,
        fx,
        borrower.user,
        borrower.collateralAta,
        collateral,
      );
      const quote = await createQuoteIx(
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
        quote.quote,
        quote.quoteVault,
        borrower.user,
        borrower.loanAta,
        lender.user.publicKey,
        lender.loanAta,
        face,
      );
    }
    const liquidator = await makeUser(program, fx, { loan: 20_000_000n });
    const market = await program.account.termMarket.fetch(fx.market);
    expect(market.totalCreditUnits.toString()).to.equal("200000000");
    expect(market.totalDebtUnits.toString()).to.equal("200000000");
    await repay(program, fx, borrowers[0].user, borrowers[0].loanAta, face);
    await price(fx);
    const before = await Promise.all(
      lenders.map((l) => tokenBalance(connection, l.loanAta)),
    );
    return { fx, lenders, borrowers, liquidator, before };
  }
  type Book = Awaited<ReturnType<typeof prepare>>;
  let books: Book[];

  async function snapshot(book: Book) {
    const keys = [
      book.fx.market,
      book.fx.loanVault,
      book.fx.collateralVault,
      book.liquidator.loanAta,
      book.liquidator.collateralAta,
      ...book.lenders.flatMap((l) => [
        l.loanAta,
        pda(program.programId).claim(book.fx.market, l.user.publicKey),
      ]),
      ...book.borrowers.map((b) =>
        pda(program.programId).obligation(book.fx.market, b.user.publicKey),
      ),
    ];
    return (await connection.getMultipleAccountsInfo(keys)).map((a) =>
      a?.data.toString("base64"),
    );
  }

  async function rejects(
    book: Book,
    action: () => Promise<unknown>,
    code: string,
  ) {
    const before = await snapshot(book);
    let caught: unknown;
    try {
      await action();
    } catch (error) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(anchor.AnchorError);
    expect((caught as anchor.AnchorError).error.errorCode.code).to.equal(code);
    expect(await snapshot(book)).to.deep.equal(before);
  }

  async function settle(book: Book) {
    await liquidate(
      program,
      book.fx,
      "default",
      book.borrowers[1].user.publicKey,
      book.liquidator.user,
      book.liquidator.loanAta,
      book.liquidator.collateralAta,
      new BN(10_000_000),
    );
    const obligation = await program.account.obligationPosition.fetch(
      pda(program.programId).obligation(
        book.fx.market,
        book.borrowers[1].user.publicKey,
      ),
    );
    expect(obligation.debtUnits.toString()).to.equal("0");
    expect(obligation.collateralAmount.toString()).to.equal("0");
    const market = await program.account.termMarket.fetch(book.fx.market);
    expect(market.totalDebtUnits.toString()).to.equal("0");
    expect(market.lossFactorWad.toString()).to.equal("450000000000000000");
  }

  async function redeemBoth(book: Book, order = [0, 1]) {
    for (const i of order) {
      const l = book.lenders[i];
      await redeem(program, book.fx, l.user, l.loanAta, face);
    }
  }

  async function paid(book: Book, expected = 55_000_000n) {
    for (let i = 0; i < 2; i++) {
      const l = book.lenders[i];
      expect(
        (await tokenBalance(connection, l.loanAta)) - book.before[i],
      ).to.equal(expected);
      expect(
        (
          await program.account.claimPosition.fetch(
            pda(program.programId).claim(book.fx.market, l.user.publicKey),
          )
        ).creditUnits.toString(),
      ).to.equal("0");
    }
    const market = await program.account.termMarket.fetch(book.fx.market);
    expect(market.totalDebtUnits.toString()).to.equal("0");
    expect(market.totalCreditUnits.toString()).to.equal("0");
    expect(await tokenBalance(connection, book.fx.loanVault)).to.equal(0n);
  }

  before(async () => {
    books = [];
    for (let i = 0; i < 5; i++) books.push(await prepare());
    await waitUntilUnix(
      connection,
      Math.max(...books.map((b) => b.fx.maturity.toNumber())),
    );
  });

  it("blocks the original early redeem and pays both lenders 55/55 after liquidation", async () => {
    const b = books[0];
    expect(
      (
        await program.account.termMarket.fetch(b.fx.market)
      ).lossFactorWad.toString(),
    ).to.equal("0");
    await rejects(
      b,
      () =>
        redeem(program, b.fx, b.lenders[0].user, b.lenders[0].loanAta, face),
      "OpenDebt",
    );
    await settle(b);
    await redeemBoth(b);
    await paid(b);
  });

  it("keeps liquidation-first payouts at 55/55 when lender order is reversed", async () => {
    const b = books[1];
    await settle(b);
    await redeemBoth(b, [1, 0]);
    await paid(b);
  });

  it("pays both lenders 55/55 in one transaction after liquidation", async () => {
    const b = books[2];
    await settle(b);
    const tx = new Transaction();
    for (const l of b.lenders) {
      tx.add(
        await program.methods
          .redeem(face)
          .accountsPartial({
            owner: l.user.publicKey,
            market: b.fx.market,
            claim: pda(program.programId).claim(b.fx.market, l.user.publicKey),
            ownerLoan: l.loanAta,
            loanVault: b.fx.loanVault,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction(),
      );
    }
    await provider.sendAndConfirm(
      tx,
      b.lenders.map((l) => l.user),
    );
    await paid(b);
  });

  it("keeps redeem closed when a wide oracle prevents liquidation", async () => {
    const b = books[3];
    await price(b.fx, 100_000);
    await rejects(b, () => settle(b), "OracleConfidenceTooWide");
    await rejects(
      b,
      () =>
        redeem(program, b.fx, b.lenders[0].user, b.lenders[0].loanAta, face),
      "OpenDebt",
    );
    await price(b.fx);
    await settle(b);
    await redeemBoth(b);
    await paid(b);
  });

  it("blocks even one remaining debt atom, then redeems at par after final repayment", async () => {
    const b = books[4];
    await repay(
      program,
      b.fx,
      b.borrowers[1].user,
      b.borrowers[1].loanAta,
      face.subn(1),
    );
    expect(
      (
        await program.account.termMarket.fetch(b.fx.market)
      ).totalDebtUnits.toString(),
    ).to.equal("1");
    await rejects(
      b,
      () =>
        redeem(program, b.fx, b.lenders[0].user, b.lenders[0].loanAta, face),
      "OpenDebt",
    );
    await repay(
      program,
      b.fx,
      b.borrowers[1].user,
      b.borrowers[1].loanAta,
      new BN(1),
    );
    await redeemBoth(b);
    await paid(b, 100_000_000n);
  });
});
