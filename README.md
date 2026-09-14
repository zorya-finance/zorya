# Zorya

**Fixed-rate credit on Solana.**

Zorya is a native Solana program that issues zero-coupon **Claims**. Lenders buy a known face on a known calendar date. Borrowers post listed collateral and sell the matching **Obligation**. The rate is a price, stored on-chain as a tick. There is no rolling APY and no interest that accrues each slot.

This repository is the **Layer 1 program** and a minimal TypeScript SDK. Apache-2.0. Fake mints and localnet / devnet only. Do not put in real capital.

Program id: `8U8gwf1R6VNX6GwbzNwnXbrBnTnR4M98aGQBzoJVTm17`

## How it works

A **TermMarket** is one loan mint, one collateral mint, one calendar maturity, one LLTV. Parameters are frozen at creation. More pairs are more markets, not a new program.

The protocol does not store a rate on each loan. It stores a **tick**. The tick maps to a price `P` in WAD (`1e18`). `P = 1` is par.

```
1 Claim      = 1 atom of the loan mint at maturity (USDC 1e-6)
1 Obligation = 1 atom of the loan mint to repay
payment now  = floor(P × units)
```

Example: tick 256, `P = 0.50`, face 100 USDC. The lender escrows 50 USDC. After fill, the lender holds 100 Claims and the borrower holds 50 USDC plus 100 Obligations. On the market date, 1 Claim pays 1 USDC atom, haircut only if bad debt was socialized.

There is no `accrue_interest()`. Debt is an integer face until repay or liquidation. The cost of credit is that `P < 1`: you receive fewer dollars today than you owe on the date.

APR and liquidation price are **display only**. Never send them to the program.

## A loan

1. **Quote.** A lender locks USDC in a quote vault and cites a tick and a face. Those dollars cannot vanish quietly. Partial fills and cancel of the remainder are allowed.
2. **Fill.** A borrower deposits collateral, then takes the quote. The program checks the tick, the escrow, the oracle, and health, then settles both sides in one instruction. No crank. No solver. The taker picks the quote.
3. **Positions.** The maker receives Claims. The taker receives USDC and Obligations. There is no bilateral loan object. Units of the same market are fungible.
4. **Date.** After `now >= maturity`, debt cannot increase. The lender redeems Claims against the market loan vault. The borrower can still repay. Unpaid debt is liquidable.

## Layer 1

This program is the book, the settlement, and the risk engine. Products call Zorya. Zorya never calls an unknown program.

| Piece | What it does |
|---|---|
| Escrowed quote book | Lender USDC sits in the quote vault before anyone can fill. The book you see is the book that pays. |
| Claims and Obligations | Market-level positions `(market, owner)`. 1 Claim is 1 USDC at the date. |
| Isolated TermMarkets | Trouble in one pair stays in that pair. Default LLTV is 70% (7000 bps). cbBTC markets use 65% (6500 bps). |
| Public Curve | One account per pair. Last fill `P`, remaining return, and volume per calendar tenor. Any program can read it. |
| Health | `max_debt = floor(collateral_value × LLTV)`. Conservative Pyth mark. Interest does not eat collateral over time: it is already in the face. |
| Default | `liquidate_health` while `debt > max_debt`. `liquidate_default` after maturity, with a 6h bonus ramp. Shortfall socializes via `loss_factor`. |

The program does **not** match. It does not walk a bid/ask. The client (or a bot) points at a quote; the program validates and settles.

Desk listings today (not a protocol cap): wSOL / USDC and JitoSOL / USDC at 70%, cbBTC / USDC at 65%. Dates: 31 Dec 2026, 31 Mar 2027, 30 Jun 2027.

### What the program accepts

The client may send a quote address and a `max_units` bound. The program recomputes `P`, payment, health, and size.

Clock is `Clock::get()?.unix_timestamp`. At `now >= maturity` the market is matured. Post-maturity liquidation uses `now > maturity` so a repay at the exact second is not punished.

Core fees are 0.

### Oracle

`create_market` with a zero feed id makes a **mock** market (localnet). A live Pyth market stores the SOL/USD feed id and the Pyth Receiver. Fill, withdraw, and liquidate take a `PriceUpdateV2` in the same transaction. The program checks owner, discriminator, `VerificationLevel::Full`, feed id, 30s age, sign, and 2% confidence.

`repay`, `redeem`, and `cancel_quote` do not read the oracle.

`set_mock_price` is compiled only with the `mock-oracle` feature (on by default for localnet). A devnet / mainnet binary must be built with `--no-default-features`.

## Layer 2 (not this repo)

Same settlement, new doors in. Not in this program:

- Signed intents (quotes that do not lock USDC)
- Borrower quotes
- Product vaults
- Secondary (sell a Claim back into the book)
- Desk API, frontend, governance token, rate AMM

Those sit on top and never get a callback from the core.

## Instructions

| Instruction | Role |
|---|---|
| `initialize_config` | Once per deployment. Authority and LLTV allowlist. |
| `create_market` | Pair, calendar maturity (Unix seconds), LLTV, oracle feed. |
| `deposit_collateral` / `withdraw_collateral` | Borrower vault. Withdraw keeps the position healthy. |
| `create_quote` / `cancel_quote` | Lender locks or recovers USDC. |
| `fill_quote` | Taker takes funded size. Settles Claim + Obligation. |
| `repay` | Burn Obligation face with USDC. |
| `redeem` | After the date, pay Claim holders from the loan vault. Partial if cash is short. |
| `liquidate_health` / `liquidate_default` | Anyone who brings USDC. No privileged liquidator. |
| `set_paused` | Stops entry. Repay, redeem, and cancel stay open. |

Authority can create markets and pause. It cannot change LLTV, maturity, oracle, or ticks on an existing market, seize funds, or mint units.

## Develop

```bash
npm run build:sbf
npm run test:fuzz
npm test
```

Production binary (no mock oracle), no deploy:

```bash
npm run test:devnet-binary
```

Local desk (three pairs × three dates, mock oracle):

```bash
# localnet running
npm run desk
```

Devnet (fake mints, no real TVL):

```bash
# throwaway wallet needs ~8 SOL on devnet (program rent ~3.81 × 2 during deploy)
npm run devnet:deploy    # no-mock binary, refuses mainnet, does not touch solana config
PYTH_API_KEY=… npm run devnet:smoke   # Hermes Bearer token + wSOL / JitoSOL / cbBTC Pyth pull
npm run build:sbf        # restore the localnet mock binary afterwards
```

Three isolated markets, one tenor (`2026-12-31`, inside the 30–180 day production window). Fake USDC, fake wSOL (SOL/USD), fake JitoSOL (JITOSOL/USD), fake cbBTC (BTC/USD — Hermes trial does not grant `Crypto.CBBTC/USD`). Addresses land in gitignored `.devnet-desk.json`.

TypeScript client: [`sdk/`](sdk/). `findPdas` is how you derive addresses. `SOL_USD_FEED_ID` and `PYTH_RECEIVER` live in `sdk/src/pyth.ts`.

```ts
import { ZoryaClient } from "./sdk/src";

const client = new ZoryaClient(program);
await client.createQuote({ ... });
await client.depositCollateral({ ... });
await client.fillQuote({ ... });
```

Do not send an APR or a liquidation price on those calls.

## License

Apache-2.0.
