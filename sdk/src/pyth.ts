import { PublicKey } from "@solana/web3.js";

/** Pyth Solana Receiver — same id on mainnet and devnet. */
export const PYTH_RECEIVER = new PublicKey(
  "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ",
);

export function feedIdFromHex(hex: string): number[] {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length !== 64) {
    throw new Error(`oracle feed hex must be 32 bytes, got ${h.length / 2}`);
  }
  return Array.from(Buffer.from(h, "hex"));
}

export const SOL_USD_FEED_HEX =
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

export const JITOSOL_USD_FEED_HEX =
  "67be9f519b95cf24338801051f9a808eff0a578ccb388db73b7f6fe1de019ffb";

export const BTC_USD_FEED_HEX =
  "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";

/** Coinbase wrapped BTC. Some Hermes plans do not grant this instrument. */
export const CBBTC_USD_FEED_HEX =
  "2817d7bfe5c64b8ea956e9a26f573ef64e72e4d7891f2d6af9bcc93f7aff9a97";

export const SOL_USD_FEED_ID = feedIdFromHex(SOL_USD_FEED_HEX);
export const JITOSOL_USD_FEED_ID = feedIdFromHex(JITOSOL_USD_FEED_HEX);
export const BTC_USD_FEED_ID = feedIdFromHex(BTC_USD_FEED_HEX);
export const CBBTC_USD_FEED_ID = feedIdFromHex(CBBTC_USD_FEED_HEX);
