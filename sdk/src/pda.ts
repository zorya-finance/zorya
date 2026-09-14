import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

function le(bn: BN, width: number): Buffer {
  return bn.toArrayLike(Buffer, "le", width);
}

export function findPdas(programId: PublicKey) {
  return {
    config: () =>
      PublicKey.findProgramAddressSync([Buffer.from("config")], programId)[0],
    market: (
      collateral: PublicKey,
      loan: PublicKey,
      maturity: BN,
      lltv: number,
    ) =>
      PublicKey.findProgramAddressSync(
        [
          Buffer.from("market"),
          collateral.toBuffer(),
          loan.toBuffer(),
          le(maturity, 8),
          le(new BN(lltv), 2),
        ],
        programId,
      )[0],
    loanVault: (market: PublicKey) =>
      PublicKey.findProgramAddressSync(
        [Buffer.from("loan-vault"), market.toBuffer()],
        programId,
      )[0],
    collateralVault: (market: PublicKey) =>
      PublicKey.findProgramAddressSync(
        [Buffer.from("collateral-vault"), market.toBuffer()],
        programId,
      )[0],
    curve: (collateral: PublicKey, loan: PublicKey) =>
      PublicKey.findProgramAddressSync(
        [Buffer.from("curve"), collateral.toBuffer(), loan.toBuffer()],
        programId,
      )[0],
    mockPrice: (market: PublicKey) =>
      PublicKey.findProgramAddressSync(
        [Buffer.from("mock-price"), market.toBuffer()],
        programId,
      )[0],
    claim: (market: PublicKey, owner: PublicKey) =>
      PublicKey.findProgramAddressSync(
        [Buffer.from("claim"), market.toBuffer(), owner.toBuffer()],
        programId,
      )[0],
    obligation: (market: PublicKey, owner: PublicKey) =>
      PublicKey.findProgramAddressSync(
        [Buffer.from("obligation"), market.toBuffer(), owner.toBuffer()],
        programId,
      )[0],
    quote: (market: PublicKey, maker: PublicKey, seq: BN) =>
      PublicKey.findProgramAddressSync(
        [Buffer.from("quote"), market.toBuffer(), maker.toBuffer(), le(seq, 8)],
        programId,
      )[0],
    quoteVault: (quote: PublicKey) =>
      PublicKey.findProgramAddressSync(
        [Buffer.from("quote-vault"), quote.toBuffer()],
        programId,
      )[0],
  };
}
