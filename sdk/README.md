# Zorya SDK

Minimal TypeScript client for the Zorya program. PDAs and instruction builders only — the program is the source of truth for prices, health, and fees.

```ts
import { ZoryaClient } from "../sdk/src";

const client = new ZoryaClient(program);
await client.depositCollateral({ ... });
await client.fillQuote({ ... });
await client.repay({ ... });
await client.withdrawCollateral({ ... });
await client.redeem({ ... });
await client.liquidate({ path: "health", ... });
```

On a Pyth market, pass the posted `PriceUpdateV2` as `priceUpdate` on `fillQuote` (and the matching withdraw / liquidate accounts). Mock markets can omit it — the client defaults to the mock-price PDA.

Feed constants: `SOL_USD_FEED_ID`, `PYTH_RECEIVER`.

Do not send an APR or liquidation price to the program. Display those off-chain.
