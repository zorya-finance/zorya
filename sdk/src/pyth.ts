import { PublicKey } from "@solana/web3.js";

/** Pyth Solana Receiver — same id on mainnet and devnet. */
export const PYTH_RECEIVER = new PublicKey(
  "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ",
);

export const SOL_USD_FEED_HEX =
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

export const SOL_USD_FEED_ID: number[] = [
  239, 13, 139, 111, 218, 44, 235, 164, 29, 161, 93, 64, 149, 209, 218, 57, 42,
  13, 47, 142, 208, 198, 199, 188, 15, 76, 250, 200, 194, 128, 181, 109,
];
