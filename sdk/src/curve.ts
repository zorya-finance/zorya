import { BN, Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { Zorya } from "../../target/types/zorya";
import { findPdas } from "./pda";

/** On-chain P is WAD (1e18). Implied remaining return is derived: WAD/P − 1. */
export const PRICE_WAD = new BN("1000000000000000000");

export interface CurvePoint {
  maturityTs: number;
  lastPriceWad: BN;
  lastFillTs: number;
  cumulativeUnits: BN;
  printed: boolean;
}

export interface CurveView {
  address: PublicKey;
  pairCollateral: PublicKey;
  pairLoan: PublicKey;
  tenorCount: number;
  points: CurvePoint[];
}

export function impliedReturnWad(priceWad: BN): BN | null {
  if (priceWad.lten(0)) return null;
  return PRICE_WAD.mul(PRICE_WAD).div(priceWad).sub(PRICE_WAD);
}

export function priceFromWad(priceWad: BN): number {
  if (priceWad.lten(0)) return 0;
  return Number(priceWad.div(new BN(1_000_000_000)).toString()) / 1_000_000_000;
}

/** One PDA fetch. No getProgramAccounts. */
export async function readCurve(
  program: Program<Zorya>,
  collateralMint: PublicKey,
  loanMint: PublicKey,
): Promise<CurveView | null> {
  const address = findPdas(program.programId).curve(collateralMint, loanMint);
  const acc = await program.account.curve.fetchNullable(address);
  if (!acc) return null;
  const count = Math.min(acc.tenorCount, acc.maturityTs.length);
  const points: CurvePoint[] = [];
  for (let i = 0; i < count; i++) {
    const lastPriceWad = acc.lastPriceWad[i];
    const maturity = acc.maturityTs[i];
    const filledAt = acc.lastFillTs[i];
    points.push({
      maturityTs:
        typeof maturity === "number" ? maturity : maturity.toNumber(),
      lastPriceWad,
      lastFillTs:
        typeof filledAt === "number" ? filledAt : filledAt.toNumber(),
      cumulativeUnits: acc.cumulativeUnits[i],
      printed: lastPriceWad.gtn(0),
    });
  }
  return {
    address,
    pairCollateral: acc.pairCollateral,
    pairLoan: acc.pairLoan,
    tenorCount: acc.tenorCount,
    points,
  };
}
