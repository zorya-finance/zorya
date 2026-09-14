//! Zorya — original Solana-native fixed-income infrastructure.
//! Not a port, fork, or translation of any EVM lending protocol.

use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;

use instructions::*;

declare_id!("8U8gwf1R6VNX6GwbzNwnXbrBnTnR4M98aGQBzoJVTm17");

#[program]
pub mod zorya {
    use super::*;

    pub fn initialize_config(ctx: Context<InitializeConfig>) -> Result<()> {
        instructions::admin::initialize_config(ctx)
    }

    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        instructions::admin::set_paused(ctx, paused)
    }

    /// Sprint 1 mock oracle. Compiled only with the `mock-oracle` feature.
    /// A mainnet binary must be built with `--no-default-features`.
    #[cfg(feature = "mock-oracle")]
    pub fn set_mock_price(ctx: Context<SetMockPrice>, price_e6: u64, conf_e6: u64) -> Result<()> {
        instructions::admin::set_mock_price(ctx, price_e6, conf_e6)
    }

    pub fn create_market(
        ctx: Context<CreateMarket>,
        maturity_ts: i64,
        lltv_bps: u16,
        liquidation_cursor_bps: u16,
        tick_delta_bps: u16,
        min_fill_units: u64,
        oracle_feed_id: [u8; 32],
    ) -> Result<()> {
        instructions::market::create_market(
            ctx,
            maturity_ts,
            lltv_bps,
            liquidation_cursor_bps,
            tick_delta_bps,
            min_fill_units,
            oracle_feed_id,
        )
    }

    pub fn deposit_collateral(ctx: Context<DepositCollateral>, amount: u64) -> Result<()> {
        instructions::collateral::deposit_collateral(ctx, amount)
    }

    pub fn withdraw_collateral(ctx: Context<WithdrawCollateral>, amount: u64) -> Result<()> {
        instructions::collateral::withdraw_collateral(ctx, amount)
    }

    pub fn create_quote(
        ctx: Context<CreateQuote>,
        quote_seq: u64,
        tick: i32,
        units: u64,
    ) -> Result<()> {
        instructions::offer::create_quote(ctx, quote_seq, tick, units)
    }

    pub fn cancel_quote(ctx: Context<CancelQuote>) -> Result<()> {
        instructions::offer::cancel_quote(ctx)
    }

    pub fn fill_quote(ctx: Context<FillQuote>, max_units: u64) -> Result<()> {
        instructions::trade::fill_quote(ctx, max_units)
    }

    pub fn repay(ctx: Context<Repay>, units: u64) -> Result<()> {
        instructions::repay::repay(ctx, units)
    }

    pub fn redeem(ctx: Context<Redeem>, units: u64) -> Result<()> {
        instructions::redeem::redeem(ctx, units)
    }

    pub fn liquidate_health(ctx: Context<Liquidate>, repaid: u64) -> Result<()> {
        instructions::liquidate::liquidate_health(ctx, repaid)
    }

    pub fn liquidate_default(ctx: Context<Liquidate>, repaid: u64) -> Result<()> {
        instructions::liquidate::liquidate_default(ctx, repaid)
    }
}
